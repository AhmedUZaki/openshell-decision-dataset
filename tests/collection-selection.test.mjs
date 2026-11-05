import test from 'node:test';
import assert from 'node:assert/strict';
import { InputError, parseNumberList, parsePolicyChoice, parseCategoryChoice, parseTaskChoice, parseRuns, buildSelection, selectionHash, calculate, planExecutions, formatCalculation, RUNS_MAX } from '../safety-router-dataset/collect-data/collection-selection.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, byCategory } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { task } from './test-helpers.mjs';
import { testTmp } from './tmp-dir.mjs';

// The generic selection engine is exercised with a multi-category fixture catalog in a temporary folder (the active catalog has one category).
const CATS = ['web-research', 'download-and-summarize', 'api-interaction', 'file-processing', 'package-and-development', 'security-boundary-tests'];
const fixtureRoot = testTmp('selection-');
mkdirSync(join(fixtureRoot, 'safety-router-dataset/task-catalog'), { recursive: true });
writeFileSync(join(fixtureRoot, 'safety-router-dataset/task-catalog/catalog.json'), JSON.stringify({ schema_version: 1, categories: CATS.map((id, i) => ({ id, title: id, description: '', order: i + 1 })), registry: {} }));
CATS.forEach((cat, ci) => {
  mkdirSync(join(fixtureRoot, 'safety-router-dataset/task-catalog', cat), { recursive: true });
  const ids = Array.from({ length: 3 + (ci === 0 || ci === 1 ? 1 : 0) }, (_, n) => `${cat}-task-${n + 1}`);
  if (cat === 'web-research') ids.push('research-topic');
  if (cat === 'download-and-summarize') ids.push('summarize-public-pdf');
  for (const id of ids) writeFileSync(join(fixtureRoot, 'safety-router-dataset/task-catalog', cat, `${id}.json`), JSON.stringify(task(id, cat)));
});
const catalog = loadCatalog(fixtureRoot);
const cats = byCategory(catalog).filter(c => c.tasks.length);
const pool = cats.flatMap(c => c.tasks);

test('numeric policy choice: one policy, or all three with option 4', () => {
  assert.deepEqual(parsePolicyChoice('1'), ['restricted']);
  assert.deepEqual(parsePolicyChoice('2'), ['balanced']);
  assert.deepEqual(parsePolicyChoice('3'), ['open']);
  assert.deepEqual(parsePolicyChoice(' 4 '), ['restricted', 'balanced', 'open']);
  for (const bad of ['', '0', '5', 'a', '1,2', '12', 'all', '-1', '1.5', 'Restricted']) assert.throws(() => parsePolicyChoice(bad), InputError, JSON.stringify(bad));
});

test('number lists: single numbers, lists, ranges and mixes, sorted and without duplicates; 0 means all', () => {
  assert.deepEqual(parseNumberList('1', 30), { all: false, numbers: [1] });
  assert.deepEqual(parseNumberList('1,3,5', 30).numbers, [1, 3, 5]);
  assert.deepEqual(parseNumberList('1-10', 30).numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(parseNumberList('1-5,12,20-25', 30).numbers, [1, 2, 3, 4, 5, 12, 20, 21, 22, 23, 24, 25]);
  assert.deepEqual(parseNumberList(' 5 , 3 ,3, 1-2 ', 30).numbers, [1, 2, 3, 5], 'spaces, order and duplicates do not matter');
  assert.deepEqual(parseNumberList('0', 30), { all: true, numbers: [] });
  for (const bad of ['', ' ', 'x', '1,', ',1', '1,,2', '1-', '-1', '1--2', '5-3', '31', '1-31', '0,1', '1,0', '0-3', '1;2', '1 2', '１', '1e1', '$(id)', '1-2-3', 'x'.repeat(300)]) assert.throws(() => parseNumberList(bad, 30), InputError, JSON.stringify(bad.slice(0, 20)));
});

test('categories: one, several, a range, or 0 for every category', () => {
  assert.equal(cats.length, 6);
  assert.deepEqual(parseCategoryChoice('1', cats), [cats[0].id]);
  assert.deepEqual(parseCategoryChoice('2,4', cats), [cats[1].id, cats[3].id]);
  assert.deepEqual(parseCategoryChoice('1-3', cats), cats.slice(0, 3).map(c => c.id));
  assert.deepEqual(parseCategoryChoice('0', cats), cats.map(c => c.id));
  assert.throws(() => parseCategoryChoice('7', cats), /not available/);
  assert.throws(() => parseCategoryChoice('1', []), /no category/);
});

test('tasks: specific numbers, ranges, and 0 selects every task with no limit', () => {
  assert.deepEqual(parseTaskChoice('1', pool), [pool[0].task_id]);
  assert.deepEqual(parseTaskChoice('1,3,5', pool), [pool[0], pool[2], pool[4]].map(t => t.task_id));
  assert.deepEqual(parseTaskChoice('1-5,12,18-20', pool), [1, 2, 3, 4, 5, 12, 18, 19, 20].map(n => pool[n - 1].task_id));
  const all = parseTaskChoice('0', pool);
  assert.deepEqual(all, pool.map(t => t.task_id), 'every task: none is dropped and no maximum is applied');
  assert.equal(all.length, pool.length);
  assert.throws(() => parseTaskChoice(String(pool.length + 1), pool), /not available/);
});

test('separate runs: the number is typed directly, Enter means 1, and the range is documented and enforced', () => {
  assert.equal(parseRuns(''), 1);
  assert.equal(parseRuns('  '), 1);
  assert.equal(parseRuns('1'), 1);
  assert.equal(parseRuns('2'), 2, 'typing 2 means two runs, not an option number');
  assert.equal(parseRuns('3'), 3);
  assert.equal(parseRuns('7'), 7);
  assert.equal(parseRuns(String(RUNS_MAX)), RUNS_MAX);
  for (const bad of ['0', String(RUNS_MAX + 1), '-1', '1.5', 'three', '2,3', '1-3', '１', '99999', '$(id)']) assert.throws(() => parseRuns(bad), InputError, bad);
});

test('the selection is validated against the catalog and is the same for the same choices', () => {
  const ids = parseTaskChoice('0', pool);
  const a = buildSelection({ policies: ['open', 'restricted'], categories: [...cats.map(c => c.id)].reverse(), taskIds: [...ids].reverse(), runs: 2 }, catalog);
  const b = buildSelection({ policies: ['restricted', 'open'], categories: cats.map(c => c.id), taskIds: ids, runs: 2 }, catalog);
  assert.deepEqual(a, b, 'order of the input does not matter');
  assert.equal(selectionHash(a), selectionHash(b));
  assert.deepEqual(a.policies, ['restricted', 'open'], 'canonical policy order');
  assert.ok(a.tasks.every(t => t.task_version >= 1 && /^[0-9a-f]{64}$/.test(t.task_hash)), 'each task carries its version and hash');
  assert.equal(a.all_tasks_in_categories, true);
  assert.notEqual(selectionHash(a), selectionHash(buildSelection({ ...{ policies: ['restricted', 'open'], categories: cats.map(c => c.id), taskIds: ids }, runs: 3 }, catalog)));
  const bad = [
    [{ policies: [], categories: ['web-research'], taskIds: ['research-topic'], runs: 1 }, /Choose Restricted/], [{ policies: ['personal'], categories: ['web-research'], taskIds: ['research-topic'], runs: 1 }, /Choose Restricted/],
    [{ policies: ['open', 'open'], categories: ['web-research'], taskIds: ['research-topic'], runs: 1 }, /Choose Restricted/], [{ policies: ['open'], categories: [], taskIds: ['research-topic'], runs: 1 }, /at least one category/],
    [{ policies: ['open'], categories: ['nope'], taskIds: ['research-topic'], runs: 1 }, /Unknown category/], [{ policies: ['open'], categories: ['web-research'], taskIds: [], runs: 1 }, /at least one task/],
    [{ policies: ['open'], categories: ['web-research'], taskIds: ['summarize-public-pdf'], runs: 1 }, /not an enabled task of the selected categories/], [{ policies: ['open'], categories: ['web-research'], taskIds: ['x; rm'], runs: 1 }, /not an enabled task/],
    [{ policies: ['open'], categories: ['web-research'], taskIds: ['research-topic'], runs: 0 }, /separate runs/], [{ policies: ['open'], categories: ['web-research'], taskIds: ['research-topic'], runs: 21 }, /separate runs/], [{ policies: ['open'], categories: ['web-research'], taskIds: ['research-topic'], runs: '2' }, /separate runs/],
  ];
  for (const [input, message] of bad) assert.throws(() => buildSelection(input, catalog), message);
});

test('the calculation is exact: tasks x policies x separate runs', () => {
  const sel = (policies, runs, taskIds = parseTaskChoice('0', pool)) => buildSelection({ policies, categories: cats.map(c => c.id), taskIds, runs }, catalog);
  const n = pool.length;
  const one = calculate(sel(['balanced'], 1));
  assert.deepEqual([one.selected_tasks, one.selected_policies, one.separate_runs, one.total_executions, one.conversations, one.sandboxes, one.expected_bundles], [n, 1, 1, n, n, n, n]);
  const three = calculate(sel(['restricted', 'balanced', 'open'], 4));
  assert.equal(three.total_executions, n * 3 * 4);
  assert.deepEqual(three.by_policy, { restricted: n * 4, balanced: n * 4, open: n * 4 });
  assert.equal(Object.values(three.by_category).reduce((a, b) => a + b, 0), three.total_executions, 'executions by category add up to the total');
  assert.equal(Object.values(three.by_policy).reduce((a, b) => a + b, 0), three.total_executions);
  assert.deepEqual(three.tasks_by_category, Object.fromEntries(cats.map(c => [c.id, c.tasks.length])));
  const some = calculate(sel(['open'], 3, [pool[0].task_id, pool[5].task_id]));
  assert.equal(some.total_executions, 2 * 1 * 3);
  // the worked example of the design: 219 tasks x 3 policies x 1 run = 657
  const fake = { selected_tasks: 219, selected_policies: 3, separate_runs: 1, total_executions: 657 };
  assert.match(formatCalculation(fake), /219 Selected Tasks\n× +3 Policies\n× +1 Separate Run\n.*\n= 657 Total Executions/);
});

test('every execution has its own id, in task, policy, run order, and none is shared', () => {
  const selection = buildSelection({ policies: ['restricted', 'balanced', 'open'], categories: cats.map(c => c.id), taskIds: parseTaskChoice('1-3', pool), runs: 2 }, catalog);
  const runId = 'run-20261103T101500-abcd';
  const ex = planExecutions(selection, runId);
  assert.equal(ex.length, calculate(selection).total_executions);
  assert.equal(new Set(ex.map(e => e.execution_id)).size, ex.length, 'unique execution ids');
  assert.ok(ex.every(e => /^run-\d{8}T\d{6}-[a-f0-9]{4}-e\d{5}$/.test(e.execution_id) && e.execution_id.startsWith(runId)));
  assert.deepEqual(ex.slice(0, 7).map(e => [e.task_number, e.policy, e.separate_run]), [[1, 'restricted', 1], [1, 'restricted', 2], [1, 'balanced', 1], [1, 'balanced', 2], [1, 'open', 1], [1, 'open', 2], [2, 'restricted', 1]]);
  assert.deepEqual(planExecutions(selection, runId), ex, 'deterministic');
  assert.deepEqual(ex.map(e => e.index), ex.map((_, i) => i + 1));
});
