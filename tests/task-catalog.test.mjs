import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, validateTask, taskHash, behaviorOf, byCategory, catalogHash, updateRegistry, tasksDir } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { main as validateMain } from '../safety-router-dataset/collect-data/validate-task-catalog.mjs';
import { testTmp } from './tmp-dir.mjs';

const task = (over = {}) => ({
  schema_version: 1, task_id: 'read-a-page', version: 1, title: 'Read a page', description: 'Reads one public page and summarizes it.', category: 'web-research',
  task_text: 'Read the page at https://example.com/ and write a two sentence summary of it.', tags: ['network'], expected_capabilities: ['network'], external_dependency: 'live_external',
  estimated_minutes: 3, enabled: true, deprecated: false, safety_notes: [], ...over,
});
const CATS = [{ id: 'web-research', title: 'Web research', description: '', order: 1 }, { id: 'api-interaction', title: 'API interaction', description: '', order: 2 }];

function makeRoot(files = {}, { categories = CATS, registry = {} } = {}) {
  const root = testTmp('catalog-');
  mkdirSync(join(root, 'safety-router-dataset/task-catalog'), { recursive: true });
  writeFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), JSON.stringify({ schema_version: 1, categories, registry }));
  for (const c of categories) mkdirSync(join(root, 'safety-router-dataset/task-catalog', c.id), { recursive: true });
  const put = (rel, content) => { mkdirSync(join(root, 'safety-router-dataset/task-catalog', rel, '..'), { recursive: true }); writeFileSync(join(root, 'safety-router-dataset/task-catalog', rel), typeof content === 'string' ? content : JSON.stringify(content)); };
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the project catalog is valid, ordered, and every task id is unique and registered', () => {
  const cat = loadCatalog();
  assert.deepEqual(cat.errors, []);
  assert.equal(cat.selectable.length, 12);
  assert.equal(new Set(cat.tasks.map(t => t.task_id)).size, cat.tasks.length);
  assert.deepEqual(cat.warnings.filter(w => /not in the registry/.test(w)), [], 'every task is in the registry');
  assert.deepEqual(cat.categories.map(c => c.id), ['single-action-policy-tests']);
  for (const t of cat.tasks) assert.ok(!/ALLOW|DENY/.test(JSON.stringify(t)), `${t.task_id} states no expected verdict`);
});

test('tasks are discovered from the folders, in deterministic order, and a new file appears without any code change', () => {
  const { root, put, done } = makeRoot({ 'web-research/b.json': task({ task_id: 'task-bbb' }), 'web-research/a.json': task({ task_id: 'task-aaa' }), 'api-interaction/c.json': task({ task_id: 'task-ccc', category: 'api-interaction' }) });
  try {
    const first = loadCatalog(root);
    assert.deepEqual(first.selectable.map(t => t.task_id), ['task-aaa', 'task-bbb', 'task-ccc']);
    assert.deepEqual(loadCatalog(root).selectable.map(t => t.task_id), first.selectable.map(t => t.task_id), 'the same order every time');
    put('web-research/new-task.json', task({ task_id: 'task-new' }));
    assert.ok(loadCatalog(root).selectable.some(t => t.task_id === 'task-new'));
    assert.deepEqual(byCategory(loadCatalog(root)).map(c => [c.id, c.tasks.length]), [['web-research', 3], ['api-interaction', 1]]);
  } finally { done(); }
});

test('schema validation rejects missing fields, wrong values, unknown fields and shell-like text', () => {
  const cats = new Set(['web-research']);
  assert.deepEqual(validateTask(task(), cats), []);
  const bad = [
    [{ task_id: undefined }, /missing required field task_id/], [{ task_id: 'A B' }, /task_id must be/], [{ task_id: 'ab' }, /task_id must be/],
    [{ version: 0 }, /version must be/], [{ version: 1.5 }, /version must be/], [{ version: '1' }, /version must be/], [{ schema_version: 2 }, /schema_version/],
    [{ title: 'x' }, /title must be/], [{ description: 'short' }, /description must be/], [{ category: 'nope' }, /not defined in catalog.json/], [{ category: 'Bad Cat' }, /category must be/],
    [{ task_text: 'too short' }, /task_text must be/], [{ tags: 'network' }, /tags must be/], [{ tags: ['a', 'a'] }, /tags must be/], [{ expected_capabilities: [] }, /expected_capabilities/], [{ expected_capabilities: ['root'] }, /expected_capabilities/],
    [{ external_dependency: 'maybe' }, /external_dependency/], [{ estimated_minutes: 0 }, /estimated_minutes/], [{ estimated_minutes: 99 }, /estimated_minutes/], [{ enabled: 'yes' }, /enabled/], [{ deprecated: 1 }, /deprecated/], [{ safety_notes: 'x' }, /safety_notes/],
    [{ extra: 1 }, /unknown field extra/],
    [{ command: 'curl https://example.com' }, /command is not allowed/], [{ argv: ['curl'] }, /argv is not allowed/], [{ executable: '/usr/bin/curl' }, /executable is not allowed/], [{ path: 'C:\\x' }, /path is not allowed/],
    [{ expected_decision: 'ALLOW' }, /expected_decision is not allowed/], [{ label: 'DENY' }, /label is not allowed/],
    [{ task_text: 'Run `curl https://example.com/` and report what it prints on screen.' }, /backtick/],
    [{ task_text: 'Fetch the page at https://example.com/ and pipe it | into a file named out in the folder.' }, /shell operator/],
    [{ task_text: 'Read the file at C:\\Users\\someone\\secret.txt and report its first lines to me please.' }, /Windows drive path/],
    [{ task_text: 'Read the file /etc/passwd and report the first lines of it to me, please do it.' }, /local filesystem path/],
    [{ task_text: 'Read ../../outside/file.txt and report what is in it, thank you very much.' }, /local filesystem path/],
    [{ task_text: 'Run sudo apt update and tell me what happens when it finishes running please.' }, /command line/],
    [{ task_text: 'Fetch https://example.com/ and expect the request to be DENIED by the policy.' }, /expected verdict/],
    [{ description: 'This one should be ALLOWED by the policy.' }, /expected verdict/],
  ];
  for (const [over, message] of bad) {
    const t = task(over); for (const k of Object.keys(over)) if (over[k] === undefined) delete t[k];
    assert.match(validateTask(t, cats).join('\n'), message, JSON.stringify(over).slice(0, 70));
  }
  assert.match(validateTask([], cats).join(), /JSON object/);
});

test('duplicate ids, a category that does not match its folder, undefined categories and invalid JSON are errors', () => {
  const { root, done } = makeRoot({
    'web-research/one.json': task({ task_id: 'same-id' }), 'api-interaction/two.json': task({ task_id: 'same-id', category: 'api-interaction' }),
    'web-research/wrong-folder.json': task({ task_id: 'wrong-folder', category: 'api-interaction' }), 'web-research/broken.json': '{ not json',
    'web-research/notes.txt': 'ignored', 'web-research/README.md': '# ok',
  });
  try {
    mkdirSync(join(root, 'safety-router-dataset/task-catalog/undefined-category'));
    writeFileSync(join(root, 'safety-router-dataset/task-catalog/undefined-category/x.json'), JSON.stringify(task({ task_id: 'x-task', category: 'undefined-category' })));
    const cat = loadCatalog(root);
    const errors = cat.errors.join('\n');
    assert.match(errors, /duplicate task_id same-id/);
    assert.match(errors, /does not match its folder web-research/);
    assert.match(errors, /broken\.json: not valid JSON/);
    assert.match(errors, /undefined-category is not a category defined in catalog.json/);
    assert.equal(cat.ok, false);
    assert.ok(!cat.selectable.some(t => t.task_id === 'same-id'), 'neither copy of a duplicate id is selectable');
    assert.ok(cat.warnings.some(w => /notes\.txt is not a task file/.test(w)) && !cat.warnings.some(w => /README/.test(w)));
  } finally { done(); }
});

test('disabled and deprecated tasks are valid but not selectable by default', () => {
  const { root, done } = makeRoot({ 'web-research/on.json': task({ task_id: 'task-on' }), 'web-research/off.json': task({ task_id: 'task-off', enabled: false }), 'web-research/old.json': task({ task_id: 'task-old', deprecated: true }) });
  try {
    const cat = loadCatalog(root);
    assert.equal(cat.ok, true);
    assert.deepEqual(cat.tasks.map(t => t.task_id), ['task-off', 'task-old', 'task-on']);
    assert.deepEqual(cat.selectable.map(t => t.task_id), ['task-on']);
    assert.deepEqual(byCategory(cat)[0].tasks.map(t => t.task_id), ['task-on']);
  } finally { done(); }
});

test('the canonical hash is stable, ignores key order and switches, and changes with the task', () => {
  const a = task(), reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(taskHash(a), taskHash(reordered));
  assert.equal(taskHash(a), taskHash(task({ enabled: false, deprecated: true, estimated_minutes: 40 })), 'switches and the time estimate are not part of the task');
  for (const over of [{ task_text: 'Read the page at https://example.com/ and write a three sentence summary of it.' }, { title: 'Read another page' }, { tags: ['network', 'reading'] }, { version: 2 }, { external_dependency: 'local_fixture' }]) assert.notEqual(taskHash(a), taskHash(task(over)), JSON.stringify(over).slice(0, 40));
  assert.deepEqual(Object.keys(behaviorOf(a)).filter(k => ['enabled', 'deprecated', 'estimated_minutes'].includes(k)), []);
  assert.match(taskHash(a), /^[0-9a-f]{64}$/);
  assert.equal(taskHash(a), 'e1ca429f3209d4f02dd1fc3e18685ff4a707a35c7a5aabebe6f4ce8198addd87', 'frozen: a change here means every recorded task hash changes');
  const { root, done } = makeRoot({ 'web-research/a.json': a });
  try { assert.equal(loadCatalog(root).tasks[0].hash, taskHash(a)); assert.equal(catalogHash(loadCatalog(root).selectable), catalogHash(loadCatalog(root).selectable)); } finally { done(); }
});

test('versions: an edited task needs a higher version, ids are never reused for other content, and the registry is updated explicitly', () => {
  const v1 = task();
  const { root, put, done } = makeRoot({ 'web-research/a.json': v1 });
  try {
    assert.ok(loadCatalog(root).warnings.some(w => /not in the registry yet/.test(w)));
    assert.deepEqual(updateRegistry(root), { changed: ['read-a-page'], total: 1 });
    assert.deepEqual(loadCatalog(root).warnings, []);
    // the same version with new text is an error: the id would silently mean something else
    put('web-research/a.json', task({ task_text: 'Read the page at https://example.org/ and write a short summary of it please.' }));
    assert.match(loadCatalog(root).errors.join('\n'), /changed but its version is still 1/);
    assert.throws(() => updateRegistry(root), /catalog has errors/);
    // a lower version is an error too
    put('web-research/a.json', task({ version: 1 }));
    // a higher version is accepted and the registry keeps the history
    put('web-research/a.json', task({ version: 2, task_text: 'Read the page at https://example.org/ and write a short summary of it please.' }));
    const bumped = loadCatalog(root);
    assert.deepEqual(bumped.errors, []);
    assert.ok(bumped.warnings.some(w => /newer than the registered 1/.test(w)));
    updateRegistry(root);
    const registry = JSON.parse(readFileSync(join(tasksDir(root), 'catalog.json'), 'utf8')).registry['read-a-page'];
    assert.deepEqual([registry.version, registry.history.map(h => h.version)], [2, [1, 2]]);
    put('web-research/a.json', task({ version: 1 }));
    assert.match(loadCatalog(root).errors.join('\n'), /lower than the registered version 2/);
    // the id stays reserved after its file is deleted
    rmSync(join(root, 'safety-router-dataset/task-catalog/web-research/a.json'));
    assert.ok(loadCatalog(root).warnings.some(w => /has no task file \(its id stays reserved/.test(w)));
  } finally { done(); }
});

test('malformed catalogs are reported, not crashed on', () => {
  const { root, done } = makeRoot();
  try {
    writeFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), '{ nope');
    assert.match(loadCatalog(root).errors.join(), /catalog.json is not valid JSON/);
    writeFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), JSON.stringify({ schema_version: 1, categories: [{ id: 'web-research', title: 'W', order: 1 }, { id: 'web-research', title: 'Dup', order: 2 }, { id: 'BAD ID', title: 'x', order: 3 }] }));
    const e = loadCatalog(root).errors.join('\n');
    assert.match(e, /duplicate category id web-research/); assert.match(e, /invalid category entry/);
    rmSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'));
    assert.match(loadCatalog(root).errors.join(), /catalog.json is missing/);
  } finally { done(); }
});

test('links inside the task folder are not followed', t => {
  const { root, done } = makeRoot({ 'web-research/ok.json': task({ task_id: 'task-ok' }) });
  try {
    const outside = testTmp('outside-');
    writeFileSync(join(outside, 'x.json'), JSON.stringify(task({ task_id: 'task-outside' })));
    try { symlinkSync(join(outside, 'x.json'), join(root, 'safety-router-dataset/task-catalog/web-research/link.json')); } catch { rmSync(outside, { recursive: true }); t.skip('this account cannot create symbolic links'); return; }
    const cat = loadCatalog(root);
    assert.ok(cat.errors.some(e => /links are not followed/.test(e)));
    assert.ok(!cat.tasks.some(x => x.task_id === 'task-outside'));
    rmSync(outside, { recursive: true });
  } finally { done(); }
});

test('the validation command exits non-zero on an invalid catalog and prints the problem', () => {
  const { root, put, done } = makeRoot({ 'web-research/a.json': task() });
  const log = console.log, error = console.error; const out = [];
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '));
  try {
    assert.equal(validateMain([], root), 0);
    put('web-research/b.json', '{ bad');
    assert.equal(validateMain([], root), 1);
    assert.match(out.join('\n'), /b\.json: not valid JSON/);
    assert.equal(validateMain(['--nope'], root), 2);
    assert.equal(validateMain(['--json'], root), 1);
  } finally { console.log = log; console.error = error; done(); }
});
