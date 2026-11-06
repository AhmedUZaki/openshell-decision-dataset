// The panel service and the whole project: no Dataset tab, no batch controls, no generic command execution, strict paths,
// and no test that touches Docker, WSL, OpenShell, Ollama or a real sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleEvidence } from '../tools/events-panel/provenance.mjs';
import { evidenceDir } from '../tools/events-panel/evidence.mjs';
import { loadCatalog, byCategory } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { testTmp, removeTestTmp, insideTestTmp, TEST_TMP, projectRoot } from './tmp-dir.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = f => readFileSync(resolve(root, f), 'utf8');
const mjs = dir => readdirSync(resolve(root, dir)).filter(f => f.endsWith('.mjs')).map(f => `${dir}/${f}`);
const sources = () => [...mjs('safety-router-dataset/collect-data'), ...mjs('safety-router-dataset/create-dataset'), ...mjs('tools/events-panel')];
const tests = () => mjs('tests');

test('the OpenShell panel is read-only except the policy tier switch, and goes into the shared my-assistant dashboard only, never into a conversation sandbox', () => {
  const ui = text('tools/events-panel/panel-ui.js'), conv = text('tools/events-panel/conversations.mjs'), enable = text('tools/events-panel/Enable-Panel.ps1');
  // Tabs: Agent activity, OpenShell events, Policy. No collection, Dataset, save or delete controls.
  assert.deepEqual([...ui.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]), ['activity', 'events', 'policy']);
  const routes = [...ui.matchAll(/call\('(\/[a-z/]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(routes, ['/agent/activity', '/events', '/policy', '/policy/tier', '/policy/tier/set'], 'the read-only routes and the confirmed tier switch');
  assert.doesNotMatch(ui, /conversations\/|\/catalog|\/dataset|Generate Dataset|deleteBundles/);
  // Chat data is drawn with textContent only: the one innerHTML is the fixed template, before any data arrives.
  assert.equal((ui.match(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/g) || []).length, 1);
  assert.match(ui, /root\.innerHTML = `<style>/);
  // Installed into the my-assistant container only; the conversation sandboxes stay untouched.
  assert.match(enable, /\^openshell-default--my-assistant-\[0-9a-f-\]\{36\}\$/);
  assert.doesNotMatch(conv, /panel-ui|patch-dashboard-ui|openshell-events-panel|control-ui\/assets/, 'conversations.mjs injects nothing');
  assert.match(conv, /async containerOf\(item\)/, 'the conversation container identity is still verified');
});
test('the live activity route is read-only, main-panel only, and passes no free text to a shell', () => {
  const server = text('tools/events-panel/panel-service.mjs');
  assert.match(server, /mainOnlyRoutes = \['\/catalog', '\/agent\/activity'\]/);
  assert.ok(server.indexOf('timingSafeEqual') < server.indexOf("req.url==='/agent/activity'"), 'the capability is checked first');
  assert.ok(server.indexOf('mainOnlyRoutes.includes(req.url)') < server.indexOf("req.url==='/agent/activity'"), 'the main-origin check runs first');
  assert.match(server, /liveExportCommands\(session\.key\)/);
  assert.doesNotMatch(server, /'sh','-c'|"sh","-c"|bash','-c/, 'no shell script built from request data');
});
test('the catalog route lists only selectable tasks from safety-router-dataset/task-catalog, read-only, for the main panel, behind the capability and origin checks', () => {
  const server = text('tools/events-panel/panel-service.mjs');
  assert.match(server, /readRoutes = \[[^\]]*'\/catalog'/);
  assert.match(server, /mainOnlyRoutes = \['\/catalog'/);
  assert.match(server, /byCategory\(catalog\)/, 'only the selectable tasks, grouped by category');
  assert.ok(server.indexOf('timingSafeEqual') < server.indexOf("req.url==='/catalog'"), 'the capability is checked first');
  assert.ok(server.indexOf('validOrigin') < server.indexOf("req.url==='/catalog'"));
  assert.match(server, /server\.listen\(18891, '127\.0\.0\.1'/);
  assert.match(server, /req\.headers\.host !== '127\.0\.0\.1:18891'/);
  assert.doesNotMatch(server, /'\/dataset\/(preview|start|status|cancel)'|'\/research\/controlled'|dataset-api|DatasetService/, 'no batch or fixed-action routes');
  assert.doesNotMatch(server, /'\/(exec|run|command|shell|eval|file|path)'/, 'no generic route');
  assert.match(server, /Request too large/);
  // the catalog the GUI sees is the catalog on disk, in its deterministic order
  const cat = loadCatalog(root);
  assert.ok(cat.ok && byCategory(cat).filter(c => c.tasks.length).length === 1 && cat.selectable.length === 12);
  assert.deepEqual(byCategory(cat).flatMap(c => c.tasks.map(t => t.task_id)), cat.selectable.map(t => t.task_id));
});

test('no generic command execution anywhere: no shell strings, eval, or exec of text built from input', () => {
  for (const f of sources()) {
    const src = text(f);
    assert.doesNotMatch(src, /[^A-Za-z_]shell\s*:\s*true|\bexecSync\b|\beval\(|new Function\(|\bspawnSync\(['"`]|child_process'\)\.exec\b/, f);
    assert.doesNotMatch(src, /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'node:child_process'/, `${f} imports the shell-based exec`);
  }
  const research = text('tools/events-panel/conversations.mjs');
  assert.doesNotMatch(research, /request\.(command|argv|args|executable|binary|path|script)\b/, 'a create request cannot carry a command');
  assert.match(research, /Only autonomous Agent conversations can be created/);
  const collector = text('safety-router-dataset/collect-data/collection-runner.mjs'), ctx = text('safety-router-dataset/collect-data/system-adapter.mjs');
  assert.doesNotMatch(collector, /child_process/, 'the collector itself starts nothing');
  assert.match(ctx, /const exec = promisify\(execFile\)/);
  assert.match(ctx, /spawn\(process\.execPath, args, \{ cwd: root/, 'the only process it spawns is node, with an argument list');
  assert.match(text('setup/Generate-Dataset.ps1'), /& \$node \$cli/);
});

test('paths are contained: evidence ids, task files, and the evidence a bundle names', () => {
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.hidden', 'a'.repeat(81)]) assert.throws(() => evidenceDir('C:\\p', 'raw', bad, 'e1'), /not valid|leaves/);
  const dir = testTmp('contain-');
  try {
    const folder = join(dir, '.local/task-captures/capture-' + 'a'.repeat(24));
    mkdirSync(join(folder, 'trajectory'), { recursive: true }); mkdirSync(join(folder, 'policy-versions'));
    for (const f of ['manifest.json', 'task.json', 'tool-calls.jsonl', 'conversation.json', 'environment.json', 'effective-policy.json', 'openshell-log-sanitized.txt', 'openshell-events.jsonl', 'trajectory/events.jsonl']) writeFileSync(join(folder, f), '');
    // a bundle that points its evidence outside .local/evidence is not complete
    for (const raw_dir of ['../../../outside', '.local/task-captures', 'C:/Windows', '.local/evidence/../../x']) {
      writeFileSync(join(folder, 'execution.json'), JSON.stringify({ evidence: { raw_dir, sanitized_dir: raw_dir } }));
      assert.equal(bundleEvidence(folder).complete, false, raw_dir);
    }
    mkdirSync(join(dir, '.local/evidence/raw/r/e'), { recursive: true }); mkdirSync(join(dir, '.local/evidence/sanitized/r/e'), { recursive: true });
    writeFileSync(join(dir, '.local/evidence/raw/r/e/manifest.json'), '{}'); writeFileSync(join(dir, '.local/evidence/sanitized/r/e/manifest.json'), '{}');
    writeFileSync(join(folder, 'execution.json'), JSON.stringify({ evidence: { raw_dir: '.local/evidence/raw/r/e', sanitized_dir: '.local/evidence/sanitized/r/e' } }));
    assert.equal(bundleEvidence(folder).complete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // the collector never deletes recursively except through its own named operations
  for (const f of ['safety-router-dataset/collect-data/collection-runner.mjs', 'safety-router-dataset/collect-data/menu.mjs', 'safety-router-dataset/collect-data/collection-selection.mjs', 'safety-router-dataset/collect-data/task-catalog.mjs']) assert.doesNotMatch(text(f), /rmSync\([^)]*recursive/, `${f} does no recursive deletion`);
  assert.doesNotMatch(text('tools/events-panel/evidence.mjs'), /rmSync|unlinkSync|rmdirSync/, 'the evidence module never deletes');
});

test('no test starts a real process, container, sandbox or model', () => {
  for (const f of tests()) {
    const src = text(f);
    const self = f === 'tests/security.test.mjs';
    assert.doesNotMatch(src.replace(/test\('no test starts[\s\S]*$/, ''), /from '\.\.?\/context\.mjs'|import\('\.\.?\/context\.mjs'\)|makeContext\(\{ root/, `${f} does not use the real system context`);
    if (!self) {
      // a test may start node on a temporary file (the validator's command line); it may start nothing else
      for (const m of src.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync)\(([^,)]*)/g)) assert.ok(/^process\.execPath$/.test(m[1].trim()), `${f} starts ${m[1]}`);
      assert.doesNotMatch(src, /require\('child_process'\)|\bexecSync\b/, `${f} uses a shell`);
      assert.doesNotMatch(src, /docker\.exe|ollama (run|pull|serve)|nemoclaw onboard|openshell sandbox create/i, f);
    }
  }
  // the verifier's determinism check starts node; the unit tests never call it
  assert.ok(!tests().some(f => /determinism\(\)/.test(text(f)) && f !== 'tests/security.test.mjs'));
});

test('every test directory lives in .local/test-tmp and is only created and removed after a containment check', () => {
  for (const f of tests()) if (f !== 'tests/security.test.mjs') assert.doesNotMatch(text(f), /\btmpdir\s*\(|from 'node:os'/, `${f} must use tests/tmp-dir.mjs, never the system temporary folder`);
  assert.equal(TEST_TMP, join(projectRoot, '.local', 'test-tmp'));
  for (const bad of ['', '   ', projectRoot, join(projectRoot, '.local'), TEST_TMP, join(TEST_TMP, '..'), join(TEST_TMP, '..', 'task-captures'), join(projectRoot, '.local', 'task-captures', 'x'), 'C:\\Windows', join(TEST_TMP, '..', 'test-tmp-evil', 'x')]) {
    assert.equal(insideTestTmp(bad), false, `${bad} is not a test directory`);
    assert.throws(() => removeTestTmp(bad), /refusing to remove/);
  }
  assert.throws(() => testTmp('../x'), /unsafe/);
  const dir = testTmp('contained-');
  try { assert.ok(insideTestTmp(dir)); assert.ok(insideTestTmp(join(dir, 'a', 'b'))); } finally { removeTestTmp(dir); }
  assert.equal(existsSync(dir), false);
});