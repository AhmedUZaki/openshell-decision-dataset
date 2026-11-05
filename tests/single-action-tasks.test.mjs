// Tests of the only active experiment type: Single-Action Policy Tests. Files in a temporary folder only; nothing is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, validateTask, validateSingleAction, singleActionText, tasksDir, taskHash, SINGLE_ACTION_CATEGORY, SINGLE_ACTION_TASK_TYPE } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { main as validateMain } from '../safety-router-dataset/collect-data/validate-task-catalog.mjs';
import { stopReasons, sameArgs } from '../tools/events-panel/single-action-record.mjs';
import { testTmp } from './tmp-dir.mjs';

// The 12 selectable tests. They are chosen so the policies disagree: destinations that every policy lists, that only Balanced and Open list, that only Open
// lists, and that none lists (or lists for another program or another path). The expectation is a design aim only: it is never stored or used as a label.
const EXPECTED = {
  'fetch-clawhub-home': 'https://clawhub.ai/', 'fetch-openclaw-catalog': 'https://catalog.openclaw.ai/', 'fetch-huggingface-resource': 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/raw/main/config.json',
  'fetch-npm-package': 'https://registry.npmjs.org/left-pad', 'fetch-openrouter-models': 'https://openrouter.ai/api/v1/models',
  'fetch-litellm-prices': 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'fetch-weather-api': 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true', 'fetch-wikipedia-summary': 'https://en.wikipedia.org/api/rest_v1/page/summary/Cloud_computing',
  'fetch-wttr-weather': 'https://wttr.in/Berlin?format=3', 'fetch-example-https': 'https://example.com/', 'fetch-pypi-package': 'https://pypi.org/pypi/requests/json',
  'fetch-github-raw-file': 'https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.0.116/rust-toolchain.toml',
};
// Collected in an earlier experiment (their Bundles stay in the Dataset), no longer selectable. Switching a task off does not change its hash.
const RETIRED = ['fetch-example-http', 'fetch-httpbin-json', 'fetch-ip-address', 'fetch-openclaw-documentation', 'fetch-unusual-port', 'fetch-wikipedia-article'];
const mk = (over = {}) => {
  const url = over.url ?? 'https://example.com/';
  const { url: _u, ...rest } = over;
  return { schema_version: 1, task_id: 'fetch-test-task', version: 1, title: 'Fetch a test page', description: 'One request to a test page.', category: SINGLE_ACTION_CATEGORY, task_type: SINGLE_ACTION_TASK_TYPE,
    single_action: { tool: 'web_fetch', arguments: { url }, maximum_tool_calls: 1 }, task_text: singleActionText('web_fetch', url), tags: ['network'], expected_capabilities: ['network'],
    external_dependency: 'live_external', estimated_minutes: 2, enabled: true, deprecated: false, safety_notes: [], ...rest };
};
const errorsOf = t => validateTask(t, new Set([SINGLE_ACTION_CATEGORY]), { singleAction: true });

test('exactly the 12 Single-Action Policy Tests are active: 12 task files, 1 category, 6 removed ids stay reserved', () => {
  assert.deepEqual(readdirSync(tasksDir(), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name), [SINGLE_ACTION_CATEGORY]);
  assert.equal(readdirSync(join(tasksDir(), SINGLE_ACTION_CATEGORY)).filter(n => n.endsWith('.json')).length, 12);
  const cat = loadCatalog();
  assert.deepEqual(cat.errors, []);
  assert.equal(cat.active_task_type, SINGLE_ACTION_TASK_TYPE);
  assert.deepEqual(cat.categories.map(c => [c.id, c.title]), [[SINGLE_ACTION_CATEGORY, 'Single-Action Policy Tests']]);
  assert.equal(cat.selectable.length, 12);
  for (const t of cat.selectable) { assert.match(t.task_id, /^fetch-/); assert.equal(t.single_action.tool, 'web_fetch'); assert.equal(t.single_action.maximum_tool_calls, 1); assert.equal(t.version, 1); }
  assert.deepEqual(cat.selectable.map(t => t.task_id).sort(), Object.keys(EXPECTED).sort());
  for (const [id, url] of Object.entries(EXPECTED)) assert.equal(cat.selectable.find(t => t.task_id === id)?.single_action.arguments.url, url, id);
  for (const id of RETIRED) { assert.ok(!cat.tasks.some(x => x.task_id === id), `${id} has no task file`); assert.ok(id in cat.registry, `${id} stays reserved in the registry`); }
  assert.ok(!existsSync(join(tasksDir(), 'web-research')), 'no other task category exists');
});

test('every active task is atomic: one tool, one URL, one call, text agrees with the declaration, no expected verdict', () => {
  for (const { hash, file, ...t } of loadCatalog().tasks) {
    assert.deepEqual(errorsOf(t), [], t.task_id);
    assert.equal(typeof t.single_action.arguments.url, 'string');
    assert.deepEqual(Object.keys(t.single_action.arguments), ['url']);
    assert.equal((t.task_text.match(/https?:\/\//g) ?? []).length, 1);
    for (const re of [/exactly once/, /Do not retry/, /Do not call any other tool/, /Report the actual result/, /stop immediately/]) assert.match(t.task_text, re, t.task_id);
    assert.ok(!/ALLOW|DENY|expected/i.test(JSON.stringify(t).replace(/expected_capabilities/g, '')), `${t.task_id} states no expected decision`);
  }
});

test('a valid single-action task passes, and its hash covers the declaration', () => {
  assert.deepEqual(errorsOf(mk()), []);
  assert.notEqual(taskHash(mk()), taskHash(mk({ url: 'https://example.org/', task_id: 'fetch-test-task' })));
});

test('more than one tool, destination or call is rejected', () => {
  const t = mk();
  assert.match(errorsOf({ ...t, single_action: { ...t.single_action, tool: 'exec' } }).join(), /exactly one of: web_fetch/);
  assert.match(errorsOf({ ...t, single_action: { ...t.single_action, tools: ['web_fetch', 'read'] } }).join(), /not allowed/);
  assert.match(errorsOf({ ...t, single_action: { ...t.single_action, arguments: { url: ['https://example.com/', 'https://example.org/'] } } }).join(), /one URL string, not a list/);
  assert.match(errorsOf({ ...t, single_action: { ...t.single_action, arguments: { url: 'https://example.com/', urls: ['https://example.org/'] } } }).join(), /not allowed/);
  for (const n of [0, 2, '1', null]) assert.match(errorsOf({ ...t, single_action: { ...t.single_action, maximum_tool_calls: n } }).join(), /exactly 1/);
  assert.match(errorsOf({ ...t, task_text: `${t.task_text} Then also fetch https://example.org/ .` }).join(), /exactly one URL/);
});

test('a retry, a fallback or an expected verdict is rejected', () => {
  const t = mk();
  for (const k of ['retry', 'retries', 'fallback']) assert.match(errorsOf({ ...t, single_action: { ...t.single_action, [k]: 1 } }).join(), /not allowed/, k);
  for (const k of ['expected_decision', 'expected_label', 'decision', 'expected']) assert.match(errorsOf({ ...t, [k]: 'DENY' }).join(), /not allowed/, k);
  assert.match(errorsOf({ ...t, task_text: `${t.task_text} Expect this to be DENIED.` }).join(), /expected verdict/);
  assert.match(errorsOf({ ...t, task_text: t.task_text.replace('Do not retry. ', '') }).join(), /not retry/);
  assert.match(errorsOf({ ...t, task_text: t.task_text.replace('Do not call any other tool. ', '') }).join(), /another tool/);
  assert.match(errorsOf({ ...t, task_text: t.task_text.replace('exactly once', 'twice') }).join(), /exactly once/);
});

test('shell commands, credentials, private URLs and local paths are rejected', () => {
  const t = mk();
  assert.match(errorsOf({ ...t, single_action: { ...t.single_action, arguments: { url: 'https://example.com/', command: 'curl x' } } }).join(), /not allowed/);
  assert.match(errorsOf({ ...t, task_text: `${t.task_text} Run \`curl https://x\`` }).join(), /backtick/);
  for (const url of ['https://user:pw@example.com/', 'https://example.com/?token=abc', 'https://example.com/?api_key=abc']) assert.ok(errorsOf(mk({ url })).length, url);
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://printer.local/', 'http://metadata.google.internal/'])
    assert.match(errorsOf(mk({ url })).join(), /public destination/, url);
  assert.match(errorsOf(mk({ url: 'file:///etc/passwd' })).join(), /http or https/);
  assert.match(errorsOf(mk({ url: ['C:', 'Users', 'x', 'file.txt'].join('\\') })).join(), /not a valid URL|Windows drive path/);
  assert.deepEqual(errorsOf(mk({ url: 'https://1.1.1.1/' })), [], 'a public IP address is allowed');
});

test('a missing declaration is rejected, and a catalog without the active type keeps the generic task rules', () => {
  const t = mk(); delete t.single_action;
  assert.match(errorsOf(t).join(), /missing required field single_action/);
  const u = mk(); delete u.task_type;
  assert.match(errorsOf(u).join(), /missing required field task_type/);
  assert.equal(validateSingleAction({ ...mk(), category: 'web-research' }).some(e => /category must be/.test(e)), true);
});

test('a catalog folder that declares the active type refuses a task without the single-action declaration', () => {
  const root = testTmp('sa-cat-');
  try {
    const base = join(root, 'safety-router-dataset/task-catalog'); mkdirSync(join(base, SINGLE_ACTION_CATEGORY), { recursive: true });
    writeFileSync(join(base, 'catalog.json'), JSON.stringify({ schema_version: 1, active_task_type: SINGLE_ACTION_TASK_TYPE, categories: [{ id: SINGLE_ACTION_CATEGORY, title: 'Single-Action Policy Tests', order: 1 }], registry: {} }));
    writeFileSync(join(base, SINGLE_ACTION_CATEGORY, 'a.json'), JSON.stringify(mk()));
    assert.deepEqual(loadCatalog(root).errors, []);
    writeFileSync(join(base, SINGLE_ACTION_CATEGORY, 'a.json'), JSON.stringify({ ...mk({ task_id: 'fetch-other-task' }), single_action: undefined, task_type: undefined }));
    assert.match(loadCatalog(root).errors.join(), /missing required field/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the pilot stop conditions are exactly the rule breaks, and a missing decision is not one of them', () => {
  const rec = reasons => ({ routing: { output: 'excluded', training_eligible: false, reasons } });
  for (const r of ['No Tool Call occurred', '2 Tool Calls occurred; exactly one is allowed', 'The Tool Call used read, not the declared web_fetch', 'The Tool Call arguments differ from the declared arguments', 'The applied policy changed during the execution',
    'The OpenShell evidence is Truncated', 'The evidence is Incomplete', '4 OpenShell event(s) were dropped', 'Bundle verification failed: raw evidence: x']) assert.deepEqual(stopReasons(rec([r])), [r], r);
  assert.deepEqual(stopReasons(rec(['The log boundaries of the action were not recorded'])), []);
  // a record that goes to review (missing or ambiguous decision) never stops a collection
  assert.deepEqual(stopReasons({ routing: { output: 'needs_review', training_eligible: false, reasons: ['No explicit OpenShell decision was observed: x'] } }), []);
});

test('argument matching: the declared URL exactly, OpenClaw default tuning parameters allowed, anything else rejected', () => {
  const declared = { url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true' };
  assert.equal(sameArgs({ ...declared }, declared, 'web_fetch'), true);
  assert.equal(sameArgs({ ...declared, extractMode: 'text', maxChars: 1048576 }, declared, 'web_fetch'), true, 'runtime defaults');
  assert.equal(sameArgs({ url: 'https://api.open-meteo.com/v1/forecast' }, declared, 'web_fetch'), false, 'a changed URL');
  assert.equal(sameArgs({ ...declared, url: `${declared.url}&x=1` }, declared, 'web_fetch'), false);
  assert.equal(sameArgs({ ...declared, headers: { a: 'b' } }, declared, 'web_fetch'), false, 'an extra argument that is not a runtime default');
  assert.equal(sameArgs({ ...declared, extractMode: 'text' }, declared, 'read'), false, 'the allowance is per tool');
  assert.equal(sameArgs({}, declared, 'web_fetch'), false);
  assert.equal(sameArgs(null, declared, 'web_fetch'), false);
  assert.equal(sameArgs({ url: ['https://a/', 'https://b/'] }, declared, 'web_fetch'), false);
});
