// The numbered menu of Generate Dataset.cmd and its progress display, driven with scripted answers and a mock system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, MENU } from '../safety-router-dataset/collect-data/menu.mjs';
import { bar, duration, renderProgress, renderLine, ProgressRenderer } from '../safety-router-dataset/collect-data/progress-display.mjs';
import { STAGES } from '../safety-router-dataset/collect-data/collection-runner.mjs';
import { makeCtx, TASKS } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const text = f => readFileSync(resolve(here, '..', f), 'utf8');

function scripted(answers, { tty = false, columns = 100 } = {}) {
  const out = [], prompts = [], written = [];
  const queue = [...answers];
  return { out, prompts, written, stream: { write: s => written.push(s) }, tty, columns, print: s => out.push(s), ask: async p => { prompts.push(p); return queue.length ? queue.shift() : null; }, remaining: () => queue.length, all: () => out.join('') + written.join('') };
}
const drive = async (answers, over = {}, ioOpts = {}) => { const k = makeCtx(over); const io = scripted(answers, ioOpts); const code = await main({ ctx: k.ctx, io }); return { ...k, io, code }; };

test('the menu opens exactly as designed and uses numbers only', async () => {
  assert.equal(MENU, ['============================================================', ' NemoClaw Safety Router Data Collector', '============================================================', '',
    '1) Start a new collection of Single-Action Policy Tests', '2) Resume a previous collection', '3) Validate the task catalog', '0) Exit', ''].join('\n'));
  const r = await drive(['0']);
  assert.ok(r.io.all().startsWith(MENU));
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, []);
});

test('malformed menu input is rejected safely and creates nothing', async () => {
  const r = await drive(['9', 'start', '1;2', '', '-1', '1.0', '$(whoami)', '0']);
  assert.match(r.io.all(), /Enter a number from 0 to 3/);
  assert.deepEqual(r.calls, []);
  assert.equal(r.code, 0);
  const tooMany = await drive(Array.from({ length: 12 }, () => 'x'));
  assert.match(tooMany.io.all(), /Too many invalid answers/);
  assert.equal(tooMany.code, 2);
});

test('a new collection with all three policies, all categories and all tasks asks for no limit and shows the exact calculation', async () => {
  const k = await drive(['1', '4', '0', '', 'RUN', '0']);
  const all = k.io.all();
  for (const needle of ['[1/4] SELECT POLICIES', '1) Restricted', '2) Balanced — NemoClaw default', '3) Open', '4) All three policies',
    'Every policy execution is independent.', 'The Agent may choose different tools or commands under different', 'policies. This measures real Agent behavior under each policy;', 'it does not prove that policy is the only variable.',
    '[2/4] SELECT SINGLE-ACTION POLICY TESTS', 'exactly one tool call, once, against one destination', '0) All tests', 'Selected Tasks: 3',
    '[3/4] SELECT INDEPENDENT EXECUTIONS', 'How many independent executions of each test under each policy?', 'Every separate run starts with:', '  - A new Conversation', '  - A new isolated Sandbox', '  - A new Agent session', '  - New OpenShell event collection', '  - No state from an earlier run',
    'Press Enter to use the default value of 1.', 'Independent executions per test and policy:\n  1',
    '[4/4] REVIEW AND CONFIRM', '3 Selected Tasks', '× +3 Policies'.replace(' +', ' '), '= 9 Total Executions']) assert.ok(all.includes(needle) || new RegExp(needle).test(all), needle);
  assert.match(all, /×\s+3 Policies/); assert.match(all, /×\s+1 Separate Run\b/);
  assert.doesNotMatch(all, /Task Templates|Independent Attempts/, 'the user-facing terms');
  assert.ok(k.io.prompts.some(p => p.includes('Type RUN (exactly) to start')), 'the confirmation asks for RUN exactly');
  assert.ok(k.io.prompts.includes('Number of independent executions [default: 1]: '), 'the number of runs is typed directly, with the default shown');
  assert.doesNotMatch(k.io.prompts.join('\n'), /limit|maximum|how many tasks/i, 'no category limit, task limit or maximum is asked');
  assert.equal(k.created.length, 9, '3 tasks x 3 policies x 1 run, every task kept');
  assert.equal(k.code, 0);
  assert.match(all, /Collection run-.*SUCCEEDED/);
  assert.deepEqual(k.calls.filter(c => c.node).map(c => c.node[0]), ['safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs']);
  assert.deepEqual([...new Set(k.created.map(c => c.body.policyTier))].sort(), ['balanced', 'open', 'restricted']);
});

test('a single policy, a category choice, a task range and a typed run count give the exact calculation, with no option-number mapping', async () => {
  const k = await drive(['1', '2', '1-2', '3', 'RUN', '0']);
  const all = k.io.all();
  assert.match(all, /Selected policies: Balanced — NemoClaw default/);
  assert.doesNotMatch(all, /Every policy execution is independent/, 'the explanation is only for several policies');
  assert.match(all, /Selected Tasks: 2/);
  assert.match(all, /Independent executions per test and policy:\n {2}3\n/, 'the typed number is the number of runs');
  assert.match(all, /2 Selected Tasks\s*\n×\s+1 Policy\s*\n×\s+3 Separate Runs/);
  assert.match(all, /=\s*6 Total Executions/);
  assert.match(all, /Isolated Conversations to create : 6/);
  assert.equal(k.created.length, 6);
  assert.ok(k.created.every(c => c.body.policyTier === 'balanced'));
  assert.deepEqual([...new Set(k.created.map(c => c.body.taskId))].sort(), ['alpha-task', 'beta-task']);
  assert.equal(k.created.filter(c => c.body.taskId === 'alpha-task').length, 3);
});

test('malformed answers at every step are explained and asked again, and nothing is created until RUN', async () => {
  const k = await drive(['1', 'x', '9', '', '2', '1-', '0-2', '999', '1', '0', '21', 'abc', '2.5', '2', 'NO', '0']);
  const all = k.io.all();
  for (const m of ['Enter 1, 2, 3 or 4', 'is not available', 'is not a valid task choice', 'cannot be combined', 'must be from 1 to 20', 'Enter a whole number from 1 to 20']) assert.ok(all.includes(m), m);
  assert.match(all, /Cancelled\. No Conversation or Sandbox was created\./);
  assert.deepEqual(k.calls, [], 'a cancelled confirmation created nothing');
  assert.equal(k.remaining?.() ?? 0, 0);
});

test('anything but RUN cancels without creating a Conversation or Sandbox', async () => {
  for (const answer of ['run', 'Run', 'RUN ', ' RUN', 'yes', 'y', '', 'R']) {
    const k = await drive(['1', '2', '1', '', answer, '0']);
    assert.match(k.io.all(), /Cancelled\. No Conversation or Sandbox was created\./, JSON.stringify(answer));
    assert.deepEqual(k.calls, [], JSON.stringify(answer));
    assert.equal(k.created.length, 0);
  }
});

test('too many invalid answers abort a selection without creating anything', async () => {
  const k = await drive(['1', 'x', 'x', 'x', 'x', 'x', '0']);
  assert.match(k.io.all(), /Too many invalid answers\. Nothing was created\./);
  assert.deepEqual(k.calls, []);
});

test('a blocked selection shows the blockers and never asks to run', async () => {
  const k = await drive(['1', '2', '1', '', 'RUN', '0'], { system: [{ name: 'Docker answers', status: 'FAIL', detail: 'not running' }] });
  const all = k.io.all();
  assert.match(all, /BLOCKED: Docker answers: not running/);
  assert.match(all, /cannot start/);
  assert.doesNotMatch(all, /Type RUN/);
  assert.deepEqual(k.calls, []);
});

test('resume lists failed collections, shows what is complete and what remains, and needs RUN again', async () => {
  let fail = true;
  const k = makeCtx({ saveError: (item, n) => fail && n === 2 ? 'disk full' : null });
  try {
    const io1 = scripted(['1', '2', '1-2', '', 'RUN', '0']);
    const code1 = await main({ ctx: k.ctx, io: io1 });
    assert.equal(code1, 1, 'a failed collection exits non-zero');
    assert.match(io1.all(), /FAILED at Saving Raw Evidence: save failed \(400\)/);
    assert.match(io1.all(), /Resume {5}: Generate Dataset\.cmd/);
    fail = false;
    const noRun = scripted(['2', '0', '0']);
    const io2 = scripted(['2', '1', 'no', '0']);
    const code2 = await main({ ctx: k.ctx, io: io2 });
    const all = io2.all();
    assert.match(all, /1\) run-\d{8}T\d{6}-[a-f0-9]{4} {2}failed {2}1\/2 executions complete/);
    assert.match(all, /completed and verified: 1\n {2}remaining: 1 of 2/);
    assert.match(all, /Resuming run-.*1 complete execution\(s\) will be skipped, 1 remain/);
    assert.match(all, /Cancelled\. No Conversation or Sandbox was created\./, 'resume also needs RUN');
    const before = k.created.length;
    const io3 = scripted(['2', '1', 'RUN', '0']);
    const code3 = await main({ ctx: k.ctx, io: io3 });
    assert.equal(code3, 0);
    assert.equal(k.created.length - before, 0, 'the remaining execution already had its environment: it was recovered, not created again');
    assert.match(io3.all(), /SUCCEEDED/);
    assert.equal(noRun.remaining(), 3);
    const io4 = scripted(['2', '0']);
    await main({ ctx: k.ctx, io: io4 });
    assert.match(io4.all(), /no failed, cancelled or interrupted collection to resume/i);
    assert.equal(code2, 2);
  } finally { k.done(); }
});

test('the collector menu validates the task catalog; the Dataset itself is created from the launcher, in one step', async () => {
  const k = await drive(['3', '0']);
  const all = k.io.all();
  assert.match(all, /Validating the task catalog/);
  assert.match(all, /3 selectable\) ?\(enabled and not deprecated\)|3 selectable \(enabled and not deprecated\)/);
  assert.match(all, /The task catalog is valid\./);
  assert.deepEqual(k.calls.filter(c => c.node), [], 'no Dataset step runs from this menu');
  assert.doesNotMatch(all, /4\) |5\) /);
  const bad = await drive(['4', '5', '0']);
  assert.match(bad.io.all(), /Enter a number from 0 to 3/);
  assert.deepEqual(bad.calls, []);
});

// ---- progress --------------------------------------------------------------------------------------------------------------------
test('the progress bar and durations', () => {
  assert.equal(bar(132, 657), '[██████------------------------] 132/657 — 20%');
  assert.equal(bar(0, 10), '[------------------------------] 0/10 — 0%');
  assert.equal(bar(10, 10), '[██████████████████████████████] 10/10 — 100%');
  assert.equal(bar(0, 0), '[------------------------------] 0/0 — 0%');
  assert.equal(bar(5, 3), '[██████████████████████████████] 3/3 — 100%', 'never beyond the total');
  assert.equal(duration(65), '1m 05s'); assert.equal(duration(3725), '1h 02m 05s'); assert.equal(duration(-4), '0m 00s');
});

const stateOf = (over = {}) => ({ run_id: 'run-20261103T101500-abcd', status: 'running', stage: 'Agent Executing', executions: Array.from({ length: 657 }, (_, i) => ({ index: i + 1 })), elapsed_seconds: 725, remaining_seconds: 2400,
  totals: { completed: 132, bundles: 132, failed: 1, raw_events: 5400, explicit_allow: 120, explicit_deny: 45, without_label: 5235 },
  current: { execution_id: 'run-20261103T101500-abcd-e00133', category: 'Web research', task_id: 'research-topic', task_title: 'Research a topic on Wikipedia', task_number: 3, tasks_total: 20, policy: 'balanced', policy_number: 2, policies_total: 3, separate_run: 1, runs_total: 2, conversation_id: 'conv-abc', sandbox_id: 'sandbox-1' }, ...over });

test('the progress block shows every required item, zeros included, within the console width', () => {
  const lines = renderProgress(stateOf(), { columns: 100 });
  const block = lines.join('\n');
  for (const needle of ['run-20261103T101500-abcd', '[██████------------------------] 132/657 — 20%', 'Agent Executing', 'Web research', '3/20 — Research a topic on Wikipedia', '2/3 — Balanced — NemoClaw default', '1/2', 'run-20261103T101500-abcd-e00133', 'conv-abc', 'sandbox-1',
    'Completed        132', 'Saved bundles 132', 'Failures 1', 'raw events 5,400', 'explicit ALLOW 120', 'explicit DENY 45', 'without labels 5,235', 'elapsed 12m 05s', 'remaining about 40m 00s']) assert.ok(block.includes(needle), needle);
  assert.ok(lines.every(l => l.length <= 100));
  const idle = renderProgress(stateOf({ status: 'succeeded', stage: 'Complete', current: null, totals: { completed: 657, bundles: 657, failed: 0, raw_events: 0, explicit_allow: 0, explicit_deny: 0, without_label: 0 } }), { columns: 140 }).join('\n');
  for (const zero of ['Failures 0', 'raw events 0', 'explicit ALLOW 0', 'explicit DENY 0', 'without labels 0']) assert.ok(idle.includes(zero), `${zero} is shown`);
  assert.ok(renderProgress(stateOf(), { columns: 60 }).every(l => l.length <= 60));
  assert.ok(STAGES.length === 15 && STAGES[0] === 'Preparing' && STAGES.at(-1) === 'Complete');
});

test('on a terminal the block is redrawn in place; elsewhere there are bounded line updates', () => {
  const tty = [], plain = [];
  let t = 0;
  const a = new ProgressRenderer({ stream: { write: s => tty.push(s) }, tty: true, columns: 100, now: () => (t += 1000), minDrawMs: 0 });
  a.update(stateOf()); a.update(stateOf({ stage: 'Saving Raw Evidence' }));
  assert.ok(!tty[0].includes('\x1b['), 'the first draw does not move the cursor');
  const lineCount = renderProgress(stateOf()).length;
  assert.ok(tty[1].startsWith(`\x1b[${lineCount}A\x1b[0J`), 'the second draw returns to the top of the block and clears it');
  const b = new ProgressRenderer({ stream: { write: s => plain.push(s) }, tty: false, columns: 100, now: () => (t += 1000), minIntervalMs: 10000 });
  for (let i = 0; i < 50; i++) b.update(stateOf());
  assert.equal(plain.length, 1, 'unchanged states do not flood the console');
  b.update(stateOf({ stage: 'Saving Raw Evidence' }));
  b.update(stateOf({ stage: 'Saving Bundle' }));
  assert.ok(plain.length <= 3 && plain.every(l => !l.includes('\x1b[') && l.length <= 101), 'no cursor codes and bounded lines');
  b.update(stateOf({ status: 'failed' }));
  assert.match(plain.at(-1), /Agent Executing|Saving/);
  const line = renderLine(stateOf(), { columns: 100 });
  assert.match(line, /^\[█+-+\] 132\/657 — 20% Agent Executing/);
  assert.ok(renderLine(stateOf(), { columns: 40 }).length <= 40);
  const c = new ProgressRenderer({ stream: { write: s => plain.push(s) }, tty: false, columns: 100, now: () => (t += 1000) });
  c.finish(stateOf({ status: 'succeeded', stage: 'Complete' }));
  assert.match(plain.at(-1), /Complete/);
});

test('the launcher passes nothing to the program and holds no logic', () => {
  const cmd = text('Generate Dataset.cmd'), ps = text('setup/Generate-Dataset.ps1');
  assert.match(cmd, /Generate-Dataset\.ps1"\r?\n/, 'the collector is started without options');
  assert.doesNotMatch(cmd, /%\*/, 'nothing is passed through');
  assert.match(cmd, /if not "%~1"=="" \(/, 'the launcher refuses options');
  assert.ok(cmd.includes('export-single-action-policy-tests.mjs'), 'option 2 creates the Dataset with one program');
  assert.ok(!/validate-single-action|verify-single-action|create-dataset-snapshot/.test(cmd.replace(/rem [^\r\n]*/g, '')), 'no separate validate, verify or snapshot steps');
  assert.ok(/:collect[\s\S]*:create/.test(cmd) && !/:export|:snapshot/.test(cmd), 'one menu with two actions');
  for (const gone of ['Export Safety Router Dataset.cmd', 'Create Timestamped Dataset Snapshot.cmd']) assert.ok(!existsSync(resolve(here, '..', gone)), `${gone} no longer exists`);
  assert.match(cmd, /chcp 65001/, 'UTF-8 so the progress bar draws');
  assert.match(ps, /& \$node \$cli/);
  assert.match(ps, /This launcher takes no options/);
  assert.doesNotMatch(ps, /Invoke-Expression|\biex\b|Start-Process|cmd\.exe|plan\.jsonl|task-captures|\$args\s*\+/i, 'no dynamic command construction');
  assert.doesNotMatch(ps, /ValidateSet|param\(/, 'no options and so no selection logic in PowerShell');
});

test('the CMD collector lists only the 12 Single-Action Policy Tests of the real catalog, and no task of any other category', async () => {
  const { loadCatalog, tasksDir } = await import('../safety-router-dataset/collect-data/task-catalog.mjs');
  const { join } = await import('node:path');
  const real = loadCatalog();
  const k = makeCtx(); k.ctx.catalog = () => real;
  try {
    const io = scripted(['1', '1', '0', '', 'NO', '0']);
    await main({ ctx: k.ctx, io });
    const all = io.all();
    assert.match(all, /SELECT SINGLE-ACTION POLICY TESTS/);
    for (const t of real.selectable) { assert.ok(all.includes(`[${t.task_id}]`), t.task_id); assert.ok(all.includes(`web_fetch ${t.single_action.arguments.url}`), t.task_id); }
    assert.equal([...all.matchAll(/\[(fetch-[a-z-]+)\]/g)].length, 12, 'exactly the 12 tests are listed');
    assert.doesNotMatch(all, /SELECT TASK CATEGORIES|Agent Evaluation|Web research|Security-boundary/);
    assert.match(all, /1\) Restricted/); assert.match(all, /Independent executions per test and policy/);
    assert.deepEqual(k.created, [], 'nothing was created');
  } finally { k.done(); }
});