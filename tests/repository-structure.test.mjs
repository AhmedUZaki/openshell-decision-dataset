// Protected-source checksums, the test launcher, project source identity, the dataset release workflow, the secret and path scan,
// and the repository hygiene rules (ignored runtime data, no user-specific paths, no license chosen on the owner's behalf).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listProtectedFiles, buildEntries, sourceManifestHash, projectIdentity, PROTECTED_RULES, MANIFEST_FILE } from '../tools/events-panel/source-identity.mjs';
import { buildManifest, manifestText, verifyManifest, writeManifest, formatVerification } from '../tools/integrity-check/source-manifest.mjs';
import { discoverTests } from './run-tests.mjs';
import { scanText, parseGitignore, isIgnored, candidateFiles, privateNames } from '../safety-router-dataset/release-checks/scan.mjs';
import { scanSource } from '../safety-router-dataset/release-checks/scan-source.mjs';
import { testTmp } from './tmp-dir.mjs';

const J = (...parts) => parts.join(''); // fixtures are assembled at run time so this file itself holds no secret-like or user-path text
const real = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(real, rel), 'utf8');

// A throw-away copy of the protected source files with its own manifest.
function sourceCopy() {
  const root = testTmp('src-copy-');
  for (const rel of listProtectedFiles(real)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); cpSync(join(real, rel), join(root, rel)); }
  writeManifest(root);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}
const edit = (root, rel, append = '\n// changed\n') => writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8') + append);

// ---- A. protected source checksums ------------------------------------------------------------------------------------------------
test('the real project tree matches setup/checksums.json', () => {
  const r = verifyManifest(real);
  assert.equal(r.ok, true, formatVerification(r).join('\n') + '\nIf you changed a protected file on purpose: node tools/integrity-check/source-manifest.mjs --write');
});

test('every dataset-defining and runtime-critical source file is protected', () => {
  const files = new Set(listProtectedFiles(real));
  for (const f of ['setup/Install-Everything.ps1', 'setup/Verify-Installation.ps1', 'setup/Verify-Checksums.ps1', 'setup/Generate-Dataset.ps1', 'setup/wsl-linux/install-stack.sh', 'setup/pins.env',
    'Install Everything.cmd', 'Start OpenClaw Workspace.cmd', 'Verify Installation.cmd', 'Generate Dataset.cmd', 'Run Tests.cmd', 'package.json', 'tests/run-tests.mjs',
    'tools/launchers/Start-OpenClaw.ps1', 'tools/events-panel/panel-service.mjs', 'tools/events-panel/conversations.mjs', 'tools/events-panel/evidence.mjs', 'tools/events-panel/service-files.txt', 'tools/events-panel/source-identity.mjs',
    'tools/integrity-check/source-manifest.mjs', 'safety-router-dataset/collect-data/collection-runner.mjs', 'safety-router-dataset/collect-data/task-catalog.mjs', 'safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/verify-single-action-policy-tests.mjs',
    'safety-router-dataset/create-dataset/schemas/single-action-policy-test-record.schema.json', 'safety-router-dataset/create-dataset/schemas/tool-call.schema.json', 'safety-router-dataset/create-dataset/schemas/conversation.schema.json', 'safety-router-dataset/release-checks/scan.mjs', 'safety-router-dataset/task-catalog/catalog.json']) assert.ok(files.has(f), `${f} is protected`);
  for (const f of readdirSync(join(real, 'safety-router-dataset/task-catalog'), { recursive: true }).filter(n => n.endsWith('.json'))) assert.ok(files.has('safety-router-dataset/task-catalog/' + f.replaceAll('\\', '/')), `${f} is protected`);
  assert.ok(!files.has(MANIFEST_FILE), 'the manifest does not list itself');
});

test('generated data, evidence, secrets and local files are never registered', () => {
  const { root, done } = sourceCopy();
  try {
    mkdirSync(join(root, '.local/dataset'), { recursive: true }); mkdirSync(join(root, '.local/evidence/raw'), { recursive: true }); mkdirSync(join(root, 'tools/node_modules/x'), { recursive: true });
    writeFileSync(join(root, '.local/dataset/x.jsonl'), '{}\n'); writeFileSync(join(root, '.local/evidence/raw/a.mjs'), 'x'); writeFileSync(join(root, 'tools/node_modules/x/i.mjs'), 'x'); writeFileSync(join(root, 'tools/events-panel/debug.log'), 'x');
    const files = listProtectedFiles(root);
    assert.ok(!files.some(f => f.startsWith('.local') || f.includes('node_modules') || f.endsWith('.log')));
    assert.equal(verifyManifest(root).ok, true, 'extra generated files do not break verification');
    for (const f of buildManifest(root).files.map(e => e.path)) assert.ok(!/^\.local|\.env$|secret|credential/i.test(f.split('/').pop()) || f === 'setup/pins.env', f);
  } finally { done(); }
});

test('modifying an exporter, a validator or a schema is detected as MODIFIED', () => {
  const { root, done } = sourceCopy();
  try {
    for (const rel of ['tools/events-panel/single-action-record.mjs', 'safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/verify-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/schemas/single-action-policy-test-record.schema.json']) {
      const before = readFileSync(join(root, rel), 'utf8');
      edit(root, rel, ' ');
      const r = verifyManifest(root);
      assert.equal(r.ok, false, rel); assert.deepEqual(r.modified, [rel]); assert.deepEqual(r.missing, []); assert.deepEqual(r.unregistered, []);
      assert.match(formatVerification(r).join('\n'), new RegExp('MODIFIED\\s+' + rel.replace(/[.\\/]/g, '\\$&')));
      writeFileSync(join(root, rel), before);
      assert.equal(verifyManifest(root).ok, true, rel + ' restored');
    }
  } finally { done(); }
});

test('a missing protected file is MISSING and an unlisted protected file is UNREGISTERED', () => {
  const { root, done } = sourceCopy();
  try {
    rmSync(join(root, 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs'));
    const m = verifyManifest(root);
    assert.deepEqual(m.missing, ['safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs']); assert.equal(m.ok, false);
    cpSync(join(real, 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs'), join(root, 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs'));
    writeFileSync(join(root, 'safety-router-dataset/create-dataset/new-exporter.mjs'), '// not registered\n');
    writeFileSync(join(root, 'Another Launcher.cmd'), '@echo off\n');
    const u = verifyManifest(root);
    assert.deepEqual(u.unregistered, ['Another Launcher.cmd', 'safety-router-dataset/create-dataset/new-exporter.mjs']); assert.equal(u.ok, false);
    assert.match(formatVerification(u).join('\n'), /UNREGISTERED\s+safety-router-dataset\/create-dataset\/new-exporter\.mjs/);
    writeManifest(root);
    assert.equal(verifyManifest(root).ok, true, 'registering the file makes verification pass');
    assert.match(formatVerification(verifyManifest(root)).join('\n'), /^PASS\s+\d+ protected source file/);
  } finally { done(); }
});

test('an unreadable or old-format manifest fails with a clear message', () => {
  const { root, done } = sourceCopy();
  try {
    writeFileSync(join(root, MANIFEST_FILE), '{ not json');
    assert.match(verifyManifest(root).error, /not valid JSON/);
    writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, algorithm: 'SHA256', files: [] }));
    assert.match(verifyManifest(root).error, /schema 2/);
    rmSync(join(root, MANIFEST_FILE));
    assert.match(verifyManifest(root).error, /is missing/);
  } finally { done(); }
});

test('checksum generation is deterministic: sorted, forward-slash, no timestamps, identical on two runs', () => {
  const a = manifestText(buildManifest(real)), b = manifestText(buildManifest(real));
  assert.equal(a, b);
  const m = JSON.parse(a);
  assert.equal(m.schemaVersion, 2); assert.equal(m.algorithm, 'SHA256');
  const paths = m.files.map(f => f.path);
  assert.deepEqual(paths, [...paths].sort((x, y) => (x < y ? -1 : 1)));
  assert.ok(paths.every(p => !p.includes('\\') && !p.startsWith('/') && !p.includes('..')));
  assert.ok(m.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a), 'no timestamp');
  assert.equal(readFileSync(join(real, MANIFEST_FILE), 'utf8'), a, 'the committed manifest is exactly what generation produces');
});

// The PowerShell verifier is exercised by hand (a test may start only node, see security.test.mjs); here its rules are pinned to the Node verifier's.
test('Verify-Checksums.ps1 applies the same protection rules as the Node verifier', () => {
  const ps = read('setup/Verify-Checksums.ps1'), m = JSON.parse(read(MANIFEST_FILE));
  assert.deepEqual(m.protected, JSON.parse(JSON.stringify(PROTECTED_RULES)), 'the rules stored in the manifest are the rules the Node code applies');
  for (const key of ['directories', 'root_file_patterns', 'root_files', 'extra_files', 'exclude_files', 'exclude_directories', 'exclude_extensions']) assert.ok(ps.includes('$rules.' + key), `the PowerShell verifier reads rules.${key}`);
  assert.match(ps, /Get-FileHash[^\n]*SHA256/); assert.match(ps, /exit 1/);
});

test('Verify Installation reports the three problems separately through Verify-Checksums.ps1', () => {
  const v = read('setup/Verify-Installation.ps1');
  assert.match(v, /Verify-Checksums\.ps1/);
  const c = read('setup/Verify-Checksums.ps1');
  for (const word of ['MISSING', 'MODIFIED', 'UNREGISTERED']) assert.ok(c.includes(word));
});

// ---- B. test launcher ----------------------------------------------------------------------------------------------------------------
test('the test launcher lists every tests/*.test.mjs in filename order and package.json exposes npm test', () => {
  const files = discoverTests().map(f => f.slice(real.length + 1).replaceAll('\\', '/'));
  const onDisk = readdirSync(join(real, 'tests')).filter(n => n.endsWith('.test.mjs')).sort().map(n => 'tests/' + n);
  assert.deepEqual(files, onDisk); assert.ok(files.includes('tests/repository-structure.test.mjs'));
  const listed = spawnSync(process.execPath, [join(real, 'tests/run-tests.mjs'), '--list'], { encoding: 'utf8' });
  assert.equal(listed.status, 0); assert.deepEqual(listed.stdout.trim().split(/\r?\n/), onDisk);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, 'node tests/run-tests.mjs');
  for (const k of ['validate:catalog', 'create:dataset', 'validate:safety-router', 'verify:safety-router', 'verify:safety-router:determinism', 'checksums:check', 'scan:source']) assert.ok(pkg.scripts[k], k);
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'no external dependencies');
  const cmd = read('Run Tests.cmd');
  assert.match(cmd, /%~dp0tests\\run-tests\.mjs/); assert.match(cmd, /pushd "%~dp0"/);
});

// ---- F. project source identity ---------------------------------------------------------------------------------------------------------
test('project identity without Git: null commit and dirty flag plus a deterministic source-manifest hash', () => {
  const { root, done } = sourceCopy();
  try {
    const a = projectIdentity(root), b = projectIdentity(root);
    assert.equal(a.git_commit, null); assert.equal(a.git_dirty, null);
    assert.deepEqual(a, b); assert.match(a.source_manifest_hash, /^[0-9a-f]{64}$/); assert.equal(a.paths, 'repository-relative');
    assert.equal(a.source_manifest_hash, sourceManifestHash(buildEntries(root)));
    edit(root, 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs', ' ');
    assert.notEqual(projectIdentity(root).source_manifest_hash, a.source_manifest_hash, 'a source change changes the identity');
  } finally { done(); }
});
test('new evidence bundles record project_identity next to the existing project_source', () => {
  assert.match(read('tools/events-panel/conversations.mjs'), /project_source:projectSource\(this\.root\),project_identity:projectIdentity\(this\.root\)/);
  assert.ok(read('tools/events-panel/service-files.txt').split(/\r?\n/).includes('source-identity.mjs'), 'the panel service ships the module');
});

test('the scan finds secrets and machine-specific paths without printing the value, and only the source scan accepts synthetic fixtures', () => {
  const names = ['bob'];
  const hits = text => scanText(text, { names }).map(f => f.rule);
  assert.deepEqual(hits('Authorization: Bearer ' + 'x'.repeat(8) + 'Zk3pQ9rT2vL5nB8cD1fG'), ['bearer-token']);
  assert.ok(hits('url https://admin:' + 'hunter2hunter2' + '@db.example.net/x').includes('url-credentials'));
  assert.ok(hits(J('pass', 'word = "', 'correcthorsebattery', '"')).includes('credential-assignment'));
  assert.ok(hits(J('C:\\Us', 'ers\\alice\\x')).includes('windows-user-path')); assert.ok(hits(J('C:/Us', 'ers/alice/x')).includes('windows-user-path'));
  assert.ok(hits(J('/mnt/c/Us', 'ers/alice/x')).includes('wsl-windows-user-path')); assert.ok(hits(J('/Us', 'ers/alice/x')).includes('macos-user-path'));
  assert.ok(hits(J('x AppD', 'ata\\Local\\Temp y')).includes('windows-appdata-path')); assert.ok(hits('built by bob today').includes('private-name'));
  assert.deepEqual(hits(J('C:\\Us', 'ers\\someone\\secret.txt') + ' and /home/linuxbrew/.linuxbrew and /sandbox/.openclaw and /tmp'), [], 'placeholders and generic sandbox paths are fine');
  const synthetic = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  assert.deepEqual(scanText(synthetic).map(f => f.rule), ['api-key-sk']); assert.deepEqual(scanText(synthetic, { allowSynthetic: true }), []);
  assert.ok(scanText('sk-' + 'Zq8Lm3Vx7Rt2Wp9Yd4Kc6Hb1').length === 1 && scanText('sk-' + 'Zq8Lm3Vx7Rt2Wp9Yd4Kc6Hb1', { allowSynthetic: true }).length === 1, 'a realistic key is never excused');
  assert.ok(!JSON.stringify(scanText(J('pass', 'word = "correcthorsebattery"'))).includes('correcthorse'));
});

test('the .gitignore evaluator ignores runtime data and releases but keeps tooling, docs and reports tracked', () => {
  const rules = parseGitignore(read('.gitignore'));
  for (const f of ['.local/dataset/x.jsonl', '.local/evidence/raw/a/b.log', '.local/runs/x/state.json', '.local/task-captures/c/manifest.json', '.env', 'node_modules/x/index.js', 'secrets.json', 'a/credentials.txt', 'x.log', 'my-assistant-effective.json']) assert.equal(isIgnored(f, rules), true, `${f} is ignored`);
  for (const f of ['README.md', 'package.json', 'Run Tests.cmd', 'safety-router-dataset/release-checks/scan.mjs', 'docs/development.md', 'LICENSE', 'setup/checksums.json', 'tests/run-tests.mjs', '.env.example']) assert.equal(isIgnored(f, rules), false, `${f} is tracked`);
  });

test('the files Git would stage contain no .local data, no secret and no user-specific path', () => {
  const files = candidateFiles(real);
  assert.ok(files.length > 50); assert.ok(!files.some(f => f.startsWith('.local/') || f.startsWith('.git/') || f.includes('node_modules')));
  assert.ok(files.includes('docs/development.md') && files.includes('package.json'));
  const r = scanSource(real);
  assert.deepEqual(r.findings, [], r.findings.map(f => `${f.file}:${f.line} ${f.rule}`).join('\n'));
  assert.ok(Array.isArray(privateNames(real)));
});

// ---- Documentation and repository decisions ---------------------------------------------------------------------------------------------
test('the owner chose MIT: the LICENSE file and the README note are in place', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License\r?\n/);
  assert.match(lic, /Copyright \(c\) 2026 The openshell-decision-dataset contributors/);
  assert.match(lic, /Permission is hereby granted, free of charge/);
  assert.match(read('README.md'), /\*\*License: MIT\*\*/);
});

test('no tracked documentation or README contains a path tied to the current user', () => {
  const docs = ['README.md', ...readdirSync(join(real, 'docs'), { recursive: true }).filter(n => /\.md$/.test(n)).map(n => 'docs/' + n.replaceAll('\\', '/'))];
  for (const f of docs) assert.deepEqual(scanText(read(f), { names: privateNames(real), file: f }).filter(x => /path|name/.test(x.rule)), [], f);
});
