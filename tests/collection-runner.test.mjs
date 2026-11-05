// Tests of the collector with a mock system and temporary folders: no Docker, WSL, OpenShell, Ollama, panel service or sandbox is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { T0, task, TASKS, CATS, LOG, NO_DECISIONS, makeCtx, select, RUN } from './test-helpers.mjs';
import { loadCatalog, byCategory } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { buildSelection, selectionHash, parseTaskChoice } from '../safety-router-dataset/collect-data/collection-selection.mjs';
import { bundleEvidence } from '../tools/events-panel/provenance.mjs';
import { writeRawEvidence, writeSanitizedEvidence, verifyRaw, evidenceDir } from '../tools/events-panel/evidence.mjs';
import {
  buildPreview, createPreview, loadPreview, startCollection, listResumable, resumePlan, requestCancel, activeRun, executionIntact, verifyExecution, estimate, estimateVolumes, executionSeconds, readHistory,
  formatReport, formatPreview, totalsOf, STAGES, PREVIEW_TTL_MS, FINAL_STEPS, shellScript, orphanSandboxes,
} from '../safety-router-dataset/collect-data/collection-runner.mjs';

// ---- preview -------------------------------------------------------------------------------------------------------------------
test('preview creates no conversation, sandbox or execution and shows the exact calculation and distribution', async () => {
  const { ctx, root, calls, done } = makeCtx();
  try {
    const selection = select(ctx, { runs: 2 });
    const before = readdirSync(ctx.dirs.runs).length;
    const p = await createPreview(ctx, selection);
    assert.deepEqual(calls, [], 'no panel call, no process, no environment');
    assert.equal(readdirSync(ctx.dirs.runs).length, before);
    assert.equal(readdirSync(ctx.dirs.captures).length, 0);
    assert.equal(existsSync(join(root, '.local/evidence')), false);
    const c = p.calculation;
    assert.deepEqual([c.selected_tasks, c.selected_policies, c.separate_runs, c.total_executions, c.conversations, c.sandboxes, c.expected_bundles], [3, 3, 2, 18, 18, 18, 18]);
    assert.deepEqual(c.by_policy, { restricted: 6, balanced: 6, open: 6 });
    assert.deepEqual(c.by_category, { 'web-research': 12, 'api-interaction': 6 });
    assert.equal(p.remaining, 18);
    assert.equal(new Set(p.remaining_execution_ids).size, 18);
    assert.equal(p.can_start, true);
    assert.match(p.preview_id, /^[a-f0-9]{32}$/);
    assert.equal(Date.parse(p.expires_at) - Date.parse(p.created_at), PREVIEW_TTL_MS);
    const text = formatPreview(p, { catalog: ctx.catalog() });
    for (const needle of ['Web research (2)', 'API interaction (1)', 'Separate runs for each task under each policy: 2', '3 Selected Tasks', '18 Total Executions', 'Isolated Conversations to create : 18', 'Isolated Sandboxes to create     : 18', 'Expected evidence bundles        : 18', 'Executions by policy', 'Executions by category', 'Estimated time', 'Estimated disk', 'Estimated raw OpenShell events', 'Estimated explicit decision events', 'Estimates are not promises', 'Preflight', 'WARNING: Every execution is independent', 'does not prove that a policy is the only variable']) assert.ok(text.includes(needle), needle);
  } finally { done(); }
});

test('estimates: 0 <= low <= estimate <= high always, and earlier runs improve them', () => {
  const ex = Array.from({ length: 12 }, (_, i) => ({ task_id: 't', policy: ['restricted', 'balanced', 'open'][i % 3] }));
  for (const hist of [[], [{ policy: 'open', seconds: 100 }], Array.from({ length: 20 }, (_, i) => ({ policy: 'open', seconds: 50 + i })), [{ policy: 'open', seconds: 10 }, { policy: 'open', seconds: 10 }, { policy: 'open', seconds: 10 }]]) {
    for (const rows of [[], ex.slice(0, 1), ex]) {
      const e = estimate(rows, () => 3, hist);
      assert.ok(e.low_seconds >= 0 && e.low_seconds <= e.estimated_seconds && e.estimated_seconds <= e.high_seconds, JSON.stringify([rows.length, hist.length, e.low_seconds, e.estimated_seconds, e.high_seconds]));
    }
  }
  assert.equal(estimate([], () => 3, []).estimated_seconds, 0);
  assert.equal(estimate(ex, () => 3, []).estimated_seconds, 12 * 180 + 60 + 24, 'no history: the tasks\' own estimated_minutes plus the fixed post-run time');
  assert.notEqual(estimate(ex, () => 3, [{ policy: 'open', seconds: 400 }]).estimated_seconds, estimate(ex, () => 3, []).estimated_seconds, 'history changes it');
  assert.deepEqual(executionSeconds({ policy: 'open' }, 3, [{ policy: 'open', seconds: 200 }, { policy: 'open', seconds: 220 }]).seconds, 210);
  assert.match(executionSeconds({ policy: 'balanced' }, 3, [{ policy: 'open', seconds: 200 }]).basis, /estimated_minutes/);
  const v = estimateVolumes(657, { avg_events: 40, decision_ratio: 0.3, bundles: 29 }, 100 * 2 ** 30);
  assert.ok(!('usable_samples' in v), 'the obsolete usable-samples estimate is gone');
  for (const r of [v.raw_events, v.explicit_decision_events]) assert.ok(r.low >= 0 && r.low <= r.estimate && r.estimate <= r.high, JSON.stringify(r));
  assert.ok(v.disk.low_bytes <= v.disk.estimated_bytes && v.disk.estimated_bytes <= v.disk.high_bytes && v.disk.required_free_bytes >= 15 * 2 ** 30);
  assert.equal(estimateVolumes(657, {}, 1 * 2 ** 30).disk.ok, false, 'little free space fails the disk check');
  assert.equal(estimateVolumes(657, {}, 400 * 2 ** 30).disk.ok, true);
});

test('history is read from earlier collections by policy', () => {
  const { ctx, done } = makeCtx();
  try {
    const dir = join(ctx.dirs.runs, 'run-20261101T100000-abcd'); mkdirSync(dir);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ kind: 'collection', executions: [{ status: 'completed', policy: 'open', seconds: 120 }, { status: 'failed', policy: 'open', seconds: 999 }, { status: 'completed', policy: 'restricted', seconds: 80 }] }));
    assert.deepEqual(readHistory(ctx.dirs.runs), [{ policy: 'open', seconds: 120 }, { policy: 'restricted', seconds: 80 }]);
  } finally { done(); }
});

test('a failed preflight, a stale task, a missing file or a missing Git exclusion blocks the start', async () => {
  for (const [over, blocker] of [[{ system: [{ name: 'Docker answers', status: 'FAIL', detail: 'down' }] }, /Docker answers/], [{ gitignore: 'node_modules\n' }, /excluded from Git/], [{ missingFile: true }, /required project files/], [{ free: 1 * 2 ** 30 }, /disk space/]]) {
    const { ctx, calls, done } = makeCtx(over);
    try {
      const p = await createPreview(ctx, select(ctx));
      assert.equal(p.can_start, false);
      assert.match(p.blockers.join('\n'), blocker);
      await assert.rejects(RUN(ctx, p, select(ctx)), /Preflight failed/);
      assert.deepEqual(calls, []);
    } finally { done(); }
  }
});

// ---- confirmation ---------------------------------------------------------------------------------------------------------------
test('nothing is created unless the confirmation is exactly RUN, and the preview is bound to the exact selection and task hashes', async () => {
  const { ctx, calls, putTask, done } = makeCtx();
  try {
    const selection = select(ctx);
    const p = await createPreview(ctx, selection);
    for (const confirmation of [undefined, '', 'run', 'Run', 'RUN ', ' RUN', 'yes', 'RUN\n', null, true]) await assert.rejects(startCollection(ctx, { previewId: p.preview_id, confirmation, selection }), /exactly RUN/);
    await assert.rejects(RUN(ctx, p, select(ctx, { runs: 2 })), /selection changed/);
    await assert.rejects(RUN(ctx, p, select(ctx, { policies: ['open'] })), /selection changed/);
    await assert.rejects(RUN(ctx, p, select(ctx, { taskIds: ['alpha-task'], categories: ['web-research'] })), /selection changed/);
    await assert.rejects(startCollection(ctx, { previewId: 'f'.repeat(32), confirmation: 'RUN', selection }), /no such preview/);
    await assert.rejects(startCollection(ctx, { previewId: '../../x', confirmation: 'RUN', selection }), /not valid/);
    assert.deepEqual(calls, [], 'no refusal created a conversation or sandbox');
    // the task changed after the preview: its hash no longer matches
    putTask(task('alpha-task', 'web-research', { version: 2, task_text: 'Read the page at https://example.com/changed and write a short summary of it.' }));
    await assert.rejects(RUN(ctx, p, selection), /Preflight failed.*alpha-task|catalog changed/);
    assert.deepEqual(calls, []);
  } finally { done(); }
});

test('an expired or already used preview cannot start', async () => {
  const { ctx, clock, calls, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const p = await createPreview(ctx, selection);
    clock.t += PREVIEW_TTL_MS + 1000;
    await assert.rejects(RUN(ctx, p, selection), /expired/);
    assert.deepEqual(calls, []);
    const q = await createPreview(ctx, selection);
    await RUN(ctx, q, selection);
    await assert.rejects(RUN(ctx, q, selection), /no such preview/);
    assert.equal(readdirSync(ctx.dirs.previews).length, 0, 'a used preview is removed');
  } finally { done(); }
});

test('only one collection can be active; a stale lock is cleared; cancel needs an active run', async () => {
  const { ctx, done } = makeCtx({ pidAlive: () => true });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const p = await createPreview(ctx, selection);
    writeFileSync(join(ctx.dirs.runs, 'active-run.json'), JSON.stringify({ run_id: 'run-20261103T090000-aaaa', pid: 4242, started_at: new Date(T0).toISOString() }));
    await assert.rejects(RUN(ctx, p, selection), /Preflight failed.*no active collection run|Another collection is active/);
    ctx.pidAlive = () => false;
    assert.equal(activeRun(ctx).stale, true);
    const q = await createPreview(ctx, selection);
    assert.equal((await RUN(ctx, q, selection)).status, 'succeeded');
    assert.equal(existsSync(join(ctx.dirs.runs, 'active-run.json')), false);
    assert.throws(() => requestCancel(ctx), /no active collection/);
  } finally { done(); }
});

// ---- one isolated environment per execution --------------------------------------------------------------------------------------
test('every execution gets its own Conversation and Sandbox, one at a time, with the exact task text, and all identifiers are saved together', async () => {
  const { ctx, root, calls, created, stages, maxOpen, done } = makeCtx();
  try {
    const selection = select(ctx, { runs: 2 });
    const p = await createPreview(ctx, selection);
    const state = await RUN(ctx, p, selection);
    assert.equal(state.status, 'succeeded');
    const total = 3 * 3 * 2;
    assert.equal(created.length, total, 'one conversation per execution');
    assert.equal(new Set(created.map(c => c.id)).size, total, 'no conversation is reused');
    assert.equal(maxOpen(), 1, 'never two environments at the same time');
    assert.equal(calls.filter(c => c.path === '/conversations/delete').length, total);
    assert.equal(new Set(created.map(c => c.body.execution.execution_id)).size, total);
    // one task text per execution: exactly the catalog's
    const sent = calls.filter(c => c.send), texts = new Map(ctx.catalog().tasks.map(t => [t.task_id, t.task_text]));
    assert.equal(sent.length, total);
    sent.forEach((s, i) => assert.equal(s.text, texts.get(created[i].body.taskId), 'the exact natural-language task'));
    assert.ok(created.every(c => c.body.taskSource === 'task_catalog' && c.body.expect.hash && !('task' in c.body) && !('experimentMode' in c.body)), 'the catalog owns the text; no experiment mode is chosen');
    // the sequence of calls: create, ... save, delete, then the next create
    const order = calls.filter(c => c.path && c.body !== null).map(c => c.path);
    assert.deepEqual(order.slice(0, 4), ['/conversations/create', '/conversations/save', '/conversations/delete', '/conversations/create']);
    // identifiers saved together, per execution
    for (const e of state.executions) {
      assert.equal(e.status, 'completed');
      const doc = JSON.parse(readFileSync(join(ctx.dirs.captures, e.capture_id, 'execution.json'), 'utf8'));
      assert.deepEqual([doc.collection_run_id, doc.execution_id, doc.task_id, doc.task_version, doc.task_hash, doc.category, doc.policy, doc.separate_run, doc.conversation_id, doc.capture_id], [state.run_id, e.execution_id, e.task_id, e.task_version, e.task_hash, e.category, e.policy, e.separate_run, e.conversation_id, e.capture_id]);
      assert.ok(doc.sandbox_id);
      assert.equal(existsSync(evidenceDir(root, 'raw', state.run_id, e.execution_id)), true);
      assert.equal(existsSync(evidenceDir(root, 'sanitized', state.run_id, e.execution_id)), true);
    }
    assert.deepEqual(calls.filter(c => c.node).map(c => c.node), FINAL_STEPS.map(([, a]) => a), 'the one Dataset-creation step, once');
    // stages seen for the first execution, in order
    const first = [...new Set(stages.filter(([id]) => id === state.executions[0].execution_id).map(([, s]) => s))];
    assert.deepEqual(first, ['Preparing', 'Creating Conversation', 'Creating Sandbox', 'Applying Policy', 'Waiting for Sandbox', 'Sending Task', 'Agent Executing', 'Stabilizing OpenShell Events', 'Saving Raw Evidence', 'Sanitizing Evidence', 'Saving Bundle', 'Verifying Bundle', 'Closing Sandbox']);
    assert.ok(STAGES.includes('Complete') && state.stage === 'Complete');
    assert.deepEqual(STAGES.slice(-2), ['Creating Dataset', 'Complete']);
    // the run log records the normalized selection, the preview id and the confirmation time
    const log = readFileSync(state.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual([log[0].event, log[0].selection, log[0].preview_id, typeof log[0].confirmed_at], ['start', selection, p.preview_id, 'string']);
    assert.ok(state.executions.every(e => e.policy === created.find(c => c.body.execution.execution_id === e.execution_id).body.policyTier), 'each execution ran under its policy');
  } finally { done(); }
});

test('the totals count every raw event, explicit decisions, and the events that are not labels, and show zeros', async () => {
  const { ctx, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task', 'beta-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    const t = state.totals;
    assert.deepEqual([t.completed, t.failed, t.bundles, t.raw_events, t.preserved, t.dropped, t.explicit_allow, t.explicit_deny, t.without_label], [2, 0, 2, 8, 8, 0, 2, 2, 4]);
    const r = state.report, text = formatReport(r);
    assert.deepEqual(r.executions, { planned: 2, completed: 2, failed: 0, pending: 0 });
    assert.deepEqual([r.evidence.raw_events_dropped], [0]);
    for (const needle of ['dropped 0', 'explicit ALLOW 2', 'explicit DENY 2', 'events without labels 4', 'Dataset creation (build, validation, independent verification, determinism, timestamped folder): passed', 'Outputs', '.local/evidence/raw/', 'never publish']) assert.ok(text.includes(needle), needle);
    assert.ok(r.disk_bytes > 0 && r.duration_seconds >= 0);
  } finally { done(); }
});

// ---- labels and evidence ----------------------------------------------------------------------------------------------------------
test('a complete bundle with no explicit decision counts as completed, and is not repeated on resume', async () => {
  const { ctx, created, done } = makeCtx({ logFor: () => NO_DECISIONS });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'succeeded');
    assert.deepEqual([state.totals.explicit_allow, state.totals.explicit_deny, state.totals.without_label, state.totals.completed], [0, 0, 2, 1]);
    assert.equal(executionIntact(ctx, { ...state.executions[0], run_id: state.run_id }).ok, true);
    const plan = resumePlan(ctx, state.run_id);
    assert.deepEqual([plan.completed, plan.remaining], [1, 0]);
    const again = await buildPreview(ctx, selection, { resume: state });
    assert.equal(again.remaining, 0);
    assert.equal(again.can_start, false, 'nothing to run: the zero-label execution is not repeated');
    assert.equal(created.length, 1);
  } finally { done(); }
});

test('raw evidence keeps every event and the sanitized layer is separate and redacted', async () => {
  const { ctx, root, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['balanced'], taskIds: ['gamma-task'], categories: ['api-interaction'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    const ex = state.executions[0];
    const raw = evidenceDir(root, 'raw', state.run_id, ex.execution_id), san = evidenceDir(root, 'sanitized', state.run_id, ex.execution_id);
    assert.match(readFileSync(join(raw, 'openshell-sandbox.log'), 'utf8'), /token=SECRET123/, 'the private raw layer is untouched');
    assert.doesNotMatch(readFileSync(join(san, 'openshell-sandbox.sanitized.log'), 'utf8'), /SECRET123/);
    assert.notEqual(raw, san);
    assert.equal(verifyRaw({ root, runId: state.run_id, executionId: ex.execution_id }).ok, true);
    const events = readFileSync(join(raw, 'openshell-events.raw.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(events.length, 4, 'heartbeat and config lines are kept as well as the two decisions');
  } finally { done(); }
});

test('verification fails when the raw structured events drop a line, or the bundle names other identifiers', async () => {
  const { ctx, root, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    const ex = { ...state.executions[0], run_id: state.run_id };
    const saved = { captureId: ex.capture_id };
    assert.equal(verifyExecution(ctx, ex, { conversationId: ex.conversation_id, saved }).ok, true);
    assert.match(verifyExecution(ctx, ex, { conversationId: 'conv-other', saved }).failures.join(), /another conversation/);
    assert.match(verifyExecution(ctx, { ...ex, separate_run: 9 }, { conversationId: ex.conversation_id, saved }).failures.join(), /separate_run/);
    const events = join(evidenceDir(root, 'raw', ex.run_id, ex.execution_id), 'openshell-events.raw.jsonl');
    chmodSync(events, 0o666);
    writeFileSync(events, readFileSync(events, 'utf8').split('\n').slice(1).join('\n'));
    const v = verifyExecution(ctx, ex, { conversationId: ex.conversation_id, saved });
    assert.equal(v.ok, false);
    assert.match(v.failures.join(), /raw evidence/);
  } finally { done(); }
});

// ---- failure, resume, cancel ------------------------------------------------------------------------------------------------------
test('a failure stops before the next execution, keeps the sandbox and the partial evidence, and skips export', async () => {
  const { ctx, root, calls, items, created, done } = makeCtx({ saveError: (item, n) => n === 2 ? 'disk full' : null });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: TASKS.map(t => t.task_id) });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'failed');
    assert.equal(created.length, 2, 'the third execution never started');
    assert.deepEqual(state.executions.map(e => e.status), ['completed', 'failed', 'pending']);
    assert.equal(calls.filter(c => c.node).length, 0, 'no export after a failed collection');
    assert.equal(items.length, 1, 'the failed execution\'s sandbox was kept');
    assert.equal(state.failed.sandbox, items[0].id);
    assert.equal(calls.filter(c => c.path === '/conversations/delete').length, 1, 'only the saved execution\'s sandbox was closed');
    assert.deepEqual(state.final, { dataset: 'skipped' });
    assert.match(state.message, /disk full/);
    assert.match(state.resume_command, /Resume a previous collection/);
    assert.equal(state.executions[0].status === 'completed' && existsSync(evidenceDir(root, 'raw', state.run_id, state.executions[0].execution_id)), true, 'the first execution\'s evidence survives');
    assert.equal(existsSync(join(ctx.dirs.runs, 'active-run.json')), false);
  } finally { done(); }
});

test('resume skips complete executions, runs the rest in new environments, keeps the old partial evidence, and needs RUN again', async () => {
  let failSave = true;
  const { ctx, root, created, calls, items, done } = makeCtx({ saveError: (item, n) => failSave && n === 2 ? 'disk full' : null });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: TASKS.map(t => t.task_id) });
    const first = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(first.status, 'failed');
    const doneBefore = first.executions[0];
    // the failed execution wrote its raw evidence before the save failed? (the mock fails before writing); simulate a partial attempt on disk
    const failedEx = first.executions[1];
    const partial = writeRawEvidence({ root, runId: first.run_id, executionId: failedEx.execution_id, text: LOG(), capture: { capture_id: 'capture-' + 'a'.repeat(24) } });
    failSave = false;
    const resumable = listResumable(ctx);
    assert.deepEqual(resumable.map(r => [r.run_id, r.status, r.completed, r.total]), [[first.run_id, 'failed', 1, 3]]);
    const plan = resumePlan(ctx, first.run_id);
    assert.deepEqual([plan.completed, plan.remaining, plan.catalog_changed], [1, 2, []]);
    const preview = await createPreview(ctx, plan.selection, { resume: plan.state });
    assert.equal(preview.remaining, 2);
    assert.equal(preview.completed_skipped, 1);
    assert.ok(!preview.remaining_execution_ids.includes(doneBefore.execution_id));
    await assert.rejects(startCollection(ctx, { previewId: preview.preview_id, confirmation: 'yes', selection: plan.selection, resumeRunId: first.run_id }), /exactly RUN/);
    await assert.rejects(startCollection(ctx, { previewId: preview.preview_id, confirmation: 'RUN', selection: plan.selection }), /different collection/, 'a resume preview cannot start a new collection');
    const createdBefore = created.length;
    const second = await startCollection(ctx, { previewId: preview.preview_id, confirmation: 'RUN', selection: plan.selection, resumeRunId: first.run_id });
    assert.equal(second.status, 'succeeded');
    assert.equal(second.run_id, first.run_id);
    assert.equal(created.length - createdBefore, 1, 'only the one execution that never started gets a new environment; the failed one is recovered');
    assert.ok(!created.slice(createdBefore).some(c => c.body.execution.execution_id === doneBefore.execution_id), 'the completed execution is not repeated');
    assert.equal(calls.filter(c => c.send === failedEx.conversation_id).length, 1, 'the recovered execution\'s task was sent once, never again');
    assert.equal(second.executions[1].conversation_id, failedEx.conversation_id, 'the same environment is recovered');
    assert.ok(second.executions.every(e => e.status === 'completed'));
    assert.equal(second.executions[1].attempts, 2);
    // the old partial evidence was moved aside, not overwritten or deleted
    assert.equal(readFileSync(join(`${partial.dir}.attempt-1`, 'openshell-sandbox.log'), 'utf8'), LOG());
    assert.equal(verifyRaw({ root, runId: first.run_id, executionId: failedEx.execution_id }).ok, true, 'the new attempt has its own evidence');
    assert.equal(calls.filter(c => c.node).length, 1, 'the Dataset is created once, after the resumed collection succeeded');
    assert.equal(items.length, 0, 'the recovered environment was closed after its evidence was saved and verified');
  } finally { done(); }
});

test('resume recovers an environment whose task was already sent: saves and verifies its evidence, closes it, never re-sends, then continues', async () => {
  let stuck = true;
  const { ctx, calls, created, items, done } = makeCtx({ saveError: () => stuck ? 'The task is still active or its completion is unconfirmed. Wait for it to finish before saving.' : null });
  try {
    const selection = select(ctx, { policies: ['restricted', 'open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const first = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(first.status, 'failed');
    assert.match(first.failed.error, /not idle after 3 attempts/);
    assert.equal(items.length, 1, 'the environment was kept with its unsaved evidence');
    const keptId = first.executions[0].conversation_id;
    stuck = false;
    const plan = resumePlan(ctx, first.run_id);
    const p = await createPreview(ctx, plan.selection, { resume: plan.state });
    const second = await startCollection(ctx, { previewId: p.preview_id, confirmation: 'RUN', selection: plan.selection, resumeRunId: first.run_id });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.failed));
    assert.equal(second.executions[0].conversation_id, keptId, 'the existing environment was recovered, not replaced');
    assert.equal(calls.filter(c => c.send === keptId).length, 1, 'the Agent received the task exactly once');
    assert.equal(created.length, 2, 'one environment per execution; no second one for the recovered execution');
    assert.ok(second.executions.every(e => e.status === 'completed' && e.capture_id));
    assert.equal(items.length, 0, 'every environment is closed');
    assert.equal(second.executions[0].attempts, 2);
  } finally { done(); }
});

test('resume after a stop condition does not run that execution again: its saved Bundle stays, its environment is closed, the collection goes on', async () => {
  let calls0 = 0;
  const { ctx, calls, created, items, done } = makeCtx({ assess: () => calls0++ === 0 ? { stop: ['No Tool Call occurred'], routing: 'excluded', openshell_policy_decision: null, task_result: 'TASK_FAILED', action_result_after_openshell: 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED', reasons: ['No Tool Call occurred'] } : { stop: [], routing: 'accepted', reasons: [] } });
  try {
    const selection = select(ctx, { policies: ['restricted', 'open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const first = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(first.status, 'failed');
    assert.match(first.failed.error, /stop condition/);
    assert.equal(items.length, 1, 'the environment was kept');
    const keptId = first.executions[0].conversation_id, capture = first.executions[0].capture_id;
    const plan = resumePlan(ctx, first.run_id);
    const p = await createPreview(ctx, plan.selection, { resume: plan.state });
    const second = await startCollection(ctx, { previewId: p.preview_id, confirmation: 'RUN', selection: plan.selection, resumeRunId: first.run_id });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.failed));
    assert.equal(second.executions[0].capture_id, capture, 'the saved Bundle is kept, not replaced');
    assert.equal(second.executions[0].status, 'completed');
    assert.equal(calls.filter(c => c.send === keptId).length, 1, 'the Agent received the task exactly once');
    assert.equal(created.length, 2, 'no second environment for the stopped execution');
    assert.equal(items.length, 0, 'every environment is closed');
    assert.deepEqual(second.executions.map(e => e.status), ['completed', 'completed']);
  } finally { done(); }
});

test('resume closes an empty environment whose task was never sent and creates a fresh one', async () => {
  let notReady = true;
  const { ctx, calls, created, items, done } = makeCtx({ panel: undefined });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    // an earlier attempt created an environment and stopped before sending anything
    const base = ctx.panel;
    ctx.panel = async (path, body, opts) => { const r = await base(path, body, opts); if (notReady && path === '/conversations/list') r.body.items = r.body.items.map(i => ({ ...i, port: null })); return r; };
    const first = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(first.status, 'failed');
    assert.ok(!calls.some(c => c.send), 'the task was never sent');
    notReady = false;
    const plan = resumePlan(ctx, first.run_id);
    const p = await createPreview(ctx, plan.selection, { resume: plan.state });
    const second = await startCollection(ctx, { previewId: p.preview_id, confirmation: 'RUN', selection: plan.selection, resumeRunId: first.run_id });
    assert.equal(second.status, 'succeeded', JSON.stringify(second.failed));
    assert.equal(created.length, 2, 'a fresh environment replaced the empty one');
    assert.equal(calls.filter(c => c.send).length, 1);
    assert.equal(items.length, 0);
  } finally { done(); }
});

test('resume refuses when a task changed since the collection started, and re-runs an execution whose evidence no longer verifies', async () => {
  const { ctx, putTask, created, done } = makeCtx({ saveError: (item, n) => n === 2 ? 'stop' : null });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task', 'beta-task'], categories: ['web-research'] });
    const first = await RUN(ctx, await createPreview(ctx, selection), selection);
    rmSync(join(ctx.dirs.captures, first.executions[0].capture_id, 'execution.json'));
    const plan = resumePlan(ctx, first.run_id);
    assert.equal(plan.completed, 0, 'a bundle that no longer verifies is not counted as complete');
    putTask(task('beta-task', 'web-research', { version: 2, task_text: 'Read the page at https://example.com/other and write a short summary of it.' }));
    assert.deepEqual(resumePlan(ctx, first.run_id).catalog_changed, ['beta-task']);
    const p = await createPreview(ctx, plan.selection, { resume: plan.state });
    await assert.rejects(startCollection(ctx, { previewId: p.preview_id, confirmation: 'RUN', selection: plan.selection, resumeRunId: first.run_id }), /changed since the collection started/);
    assert.equal(created.length, 2);
  } finally { done(); }
});

test('cancel is honoured only between executions: the running one is saved and closed first, and no export follows', async () => {
  let ctxRef;
  const { ctx, calls, created, done } = makeCtx({ onSend: async () => { if (!ctxRef.cancelled) { ctxRef.cancelled = true; requestCancel(ctxRef.ctx); } } });
  try {
    ctxRef = { ctx };
    const selection = select(ctx, { policies: ['open'], taskIds: TASKS.map(t => t.task_id) });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'cancelled');
    assert.deepEqual(state.executions.map(e => e.status), ['completed', 'pending', 'pending']);
    assert.equal(created.length, 1);
    assert.equal(calls.filter(c => c.path === '/conversations/delete').length, 1, 'the execution in progress was finished and its sandbox closed');
    assert.equal(calls.filter(c => c.node).length, 0);
    assert.ok(readFileSync(state.log, 'utf8').includes('"event":"cancelled"'));
    assert.deepEqual(listResumable(ctx).map(r => r.status), ['cancelled']);
  } finally { done(); }
});

test('a failed or unconfirmed sandbox closure is a failure, never a success, and the saved evidence stays', async () => {
  for (const mode of ['status', 'body', 'listed']) {
    const { ctx, items, calls, done } = makeCtx();
    try {
      const base = ctx.panel;
      ctx.panel = async (path, body, opts) => {
        if (path !== '/conversations/delete') return base(path, body, opts);
        calls.push({ path, body });
        if (mode === 'status') return { status: 500, body: { error: 'docker error' } };
        if (mode === 'body') return { status: 200, body: { removed: 'conv-other' } };
        return { status: 200, body: { removed: body.id } };
      };
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task', 'beta-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed', mode);
      assert.equal(state.failed.stage, 'Closing Sandbox');
      assert.match(state.failed.error, mode === 'listed' ? /still listed/ : /deletion failed/);
      assert.equal(state.executions[0].status, 'failed');
      assert.ok(state.executions[0].capture_id, 'its bundle was saved before the closure failed');
      assert.equal(state.executions[1].status, 'pending', 'the next execution did not start');
      assert.equal(calls.filter(c => c.node).length, 0);
      assert.doesNotMatch(readFileSync(state.log, 'utf8'), /"event":"closed"/);
      assert.equal(items.length, 1);
    } finally { done(); }
  }
});

test('an incomplete bundle, a task that changed mid-run, a sandbox on the wrong policy and a sandbox that never gets ready are failures before anything is repeated', async () => {
  { // incomplete bundle
    const { ctx, calls, items, done } = makeCtx({ bundleStatus: (id, missing) => ({ complete: false, missing: ['trajectory/events.jsonl'] }) });
    try {
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed'); assert.match(state.failed.error, /incomplete/);
      assert.equal(calls.some(c => c.path === '/conversations/delete'), false); assert.equal(items.length, 1);
    } finally { done(); }
  }
  { // task changed after the collection started
    const { ctx, putTask, created, calls, done } = makeCtx({ onSend: async () => { putTask(task('beta-task', 'web-research', { version: 2, task_text: 'Read the page at https://example.com/new and write a short summary of it.' })); } });
    try {
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task', 'beta-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed'); assert.match(state.failed.error, /task changed since the collection started/);
      assert.equal(state.failed.before_action, true);
      assert.equal(created.length, 1, 'no environment was created for the changed task');
      assert.equal(calls.filter(c => c.node).length, 0);
    } finally { done(); }
  }
  { // wrong policy reported
    const { ctx, calls, done } = makeCtx();
    try {
      const base = ctx.panel;
      ctx.panel = async (path, body, opts) => { const r = await base(path, body, opts); if (path === '/conversations/list') r.body.items.forEach(i => { i.policyTier = 'balanced'; }); return r; };
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed'); assert.match(state.failed.error, /reports policy balanced, not open/);
      assert.equal(calls.some(c => c.send), false, 'the task was never sent');
    } finally { done(); }
  }
  { // never ready
    const { ctx, calls, done } = makeCtx({ panel: async (path) => path === '/conversations/create' ? { status: 200, body: { id: 'conv-0000000001' } } : { status: 200, body: { items: [{ id: 'conv-0000000001', status: 'creating' }] } } });
    try {
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.match(state.failed.error, /not ready/); assert.equal(state.failed.before_action, true);
      assert.equal(calls.some(c => c.send), false);
    } finally { done(); }
  }
});

test('only "not idle yet" save failures are retried: the Agent is never sent the task twice', async () => {
  let n = 0;
  const { ctx, calls, done } = makeCtx({ saveError: () => (++n < 3 ? 'The task is still active or its completion is unconfirmed.' : null) });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'succeeded');
    assert.equal(calls.filter(c => c.send).length, 1);
    const hard = makeCtx({ saveError: () => 'some other error' });
    try {
      const s2 = select(hard.ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const st = await RUN(hard.ctx, await createPreview(hard.ctx, s2), s2);
      assert.equal(st.status, 'failed');
      assert.equal(hard.calls.filter(c => c.path === '/conversations/save').length, 1, 'no retry for another error');
    } finally { hard.done(); }
  } finally { done(); }
});

test('the final step creates the Dataset in one go; if it fails the collection fails but the saved evidence stays', async () => {
  const { ctx, calls, done } = makeCtx({ runNode: () => ({ code: 1, output: 'boom' }) });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.deepEqual(calls.filter(c => c.node).map(c => c.node), [['safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs']], 'one step: build, validate, verify and save together');
    assert.equal(state.status, 'failed');
    assert.equal(state.final.dataset, 'failed');
    assert.equal(state.totals.bundles, 1, 'the saved evidence stays');
    assert.equal(state.executions[0].status, 'completed');
  } finally { done(); }
});

test('progress is written while the run goes, bounded, with a measured remaining time', async () => {
  const { ctx, done } = makeCtx();
  try {
    const seen = [];
    ctx.onUpdate = s => seen.push(JSON.parse(JSON.stringify({ current: s.current, completed: s.totals.completed, stage: s.stage, tail: s.tail, elapsed: s.elapsed_seconds, remaining: s.remaining_seconds, bundles: s.totals.bundles })));
    const selection = select(ctx, { policies: ['restricted', 'open'], taskIds: ['alpha-task', 'beta-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.totals.completed, 4);
    assert.ok(seen.every(s => s.tail.length <= 60 && s.tail.every(l => l.length <= 400)));
    const running = seen.filter(s => s.current);
    assert.ok(running.some(s => s.current.task_number === 2 && s.current.policy === 'open' && s.current.runs_total === 1 && s.current.policies_total === 2 && s.current.tasks_total === 2));
    assert.ok(running.every(s => s.current.category === 'Web research' && /^conv-/.test(s.current.conversation_id ?? 'conv-') || !s.current.conversation_id));
    assert.ok(seen.at(-1).elapsed >= seen[0].elapsed);
    const state2 = JSON.parse(readFileSync(join(ctx.dirs.runs, state.run_id, 'state.json'), 'utf8'));
    assert.equal(state2.totals.completed, 4);
    assert.equal(totalsOf(state2.executions).completed, 4);
  } finally { done(); }
});

test('the task text is passed to the Agent as one quoted word, never as shell syntax', () => {
  const script = shellScript('conv-0123456789', "Run `python3 -c \"print('hi')\"` now");
  assert.match(script, /-m 'Run `python3 -c "print\('\\''hi'\\''\)"` now'/);
  assert.match(script, /nemoclaw conv-0123456789 exec --timeout 400 -- openclaw agent --session-key agent:main:main/);
  assert.doesNotMatch(shellScript('conv-0123456789', 'plain'), /\$\(|`;/);
});

test('leftover sandbox containers are found', () => {
  const names = ['openshell-default--my-assistant-b82d4e31-b242', 'openshell-default--research-152e8196ac-4fdb7d21-17d5', 'openshell-default--conv-0123456789-aaaa-bbbb'];
  assert.deepEqual(orphanSandboxes(names, ['conv-aaaaaaaaaa']), ['conv-0123456789']);
  assert.deepEqual(orphanSandboxes(names, ['conv-aaaaaaaaaa', 'conv-0123456789']), []);
});

test('collection status and task outcome are separate: a failed task with saved evidence is a successful collection, and truncated evidence is counted', async () => {
  const { LOG_LIMIT } = await import('../tools/events-panel/evidence.mjs');
  const outcomes = ['Succeeded', 'Failed', 'Partial'];
  const big = Array.from({ length: LOG_LIMIT }, (_, i) => `[1793570001.${String(i % 1000).padStart(3, '0')}] [sandbox] [INFO ] [proxy] heartbeat ${i}`).join('\n') + '\n';
  const { ctx, done } = makeCtx({ taskOutcome: item => ({ value: outcomes[Number(item.id.slice(-1)) - 1], tool_calls: 1, succeeded: 0, failed: 0, without_result: 0 }), logFor: ex => (ex.separate_run === 1 && ex.execution_id.endsWith('e00002') ? big : LOG(1)) });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: TASKS.map(t => t.task_id) });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'succeeded', JSON.stringify(state.failed));
    assert.deepEqual(state.executions.map(e => [e.collection_status, e.task_outcome, e.evidence_completeness]), [['Succeeded', 'Succeeded', 'Complete'], ['Succeeded', 'Failed', 'Truncated'], ['Succeeded', 'Partial', 'Complete']]);
    assert.deepEqual(state.totals.task_outcomes, { Succeeded: 1, Failed: 1, Partial: 1, Unknown: 0 });
    assert.equal(state.totals.truncated_evidence, 1);
    const r = state.report, text = formatReport(r);
    assert.deepEqual([r.collection_status, r.evidence_completeness], [{ succeeded: 3, failed: 0, not_run: 0 }, { complete: 2, truncated: 1 }]);
    for (const needle of ['Collection : succeeded 3, failed 0', 'Tool execution outcome: Succeeded 1, Failed 1, Partial 1, Unknown 0', 'complete 2, truncated 1', 'withheld from training by default']) assert.ok(text.includes(needle), needle);
  } finally { done(); }
});

test('the report splits its results by policy, from each policy\'s own executions', async () => {
  const { ctx, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['restricted', 'balanced', 'open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    const r = state.report;
    assert.deepEqual(Object.keys(r.by_policy), ['restricted', 'balanced', 'open']);
    for (const p of Object.keys(r.by_policy)) assert.deepEqual([r.by_policy[p].planned, r.by_policy[p].completed, r.by_policy[p].failed, r.by_policy[p].not_run], [1, 1, 0, 0], p);
    const sum = k => Object.values(r.by_policy).reduce((n, x) => n + x[k], 0);
    const t = state.totals;
    // every figure of every policy row adds up to the overall totals, zeros included
    const pairs = { planned: r.executions.planned, completed: t.completed, failed: t.failed, not_run: 0, evidence_complete: r.evidence_completeness.complete, evidence_truncated: r.evidence_completeness.truncated, raw_events: t.raw_events, raw_events_dropped: t.dropped,
      explicit_allow: t.explicit_allow, explicit_deny: t.explicit_deny, without_decision: t.without_label };
    for (const [k, v] of Object.entries(pairs)) assert.equal(sum(k), v, `by_policy ${k} adds up to the total`);
    for (const o of ['Succeeded', 'Failed', 'Partial', 'Unknown']) assert.equal(Object.values(r.by_policy).reduce((n, x) => n + x.task_outcomes[o], 0), r.task_outcomes[o], `tool execution outcome ${o}`);
    const text = formatReport(r);
    for (const needle of ['By policy', 'Restricted: planned 1, collected 1, collection failed 0, not run 0; evidence complete 1, truncated 0', 'Balanced — NemoClaw default: planned 1', 'Open: planned 1', 'tool execution outcome Succeeded', 'without decision', 'Tool execution outcome:', 'Events     :', 'kept in the raw evidence']) assert.ok(text.includes(needle), needle);
  } finally { done(); }
});

test('an execution whose bundle records no task outcome or evidence completeness does not verify', async () => {
  for (const [name, change] of [['task outcome', d => { delete d.task_outcome; }], ['evidence completeness', d => { delete d.evidence_completeness; }], ['a made-up outcome', d => { d.task_outcome = { value: 'Great' }; }]]) {
    const { ctx, done } = makeCtx({ executionDoc: change });
    try {
      const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed', name);
      assert.equal(state.executions[0].collection_status, 'Failed');
      assert.match(state.failed.error, /records no tool execution outcome|records no evidence completeness|disagree/, name);
    } finally { done(); }
  }
});

test('the log boundaries and times of every execution are saved beside its run, before the Bundle, and an earlier attempt is never overwritten', async () => {
  const { ctx, done } = makeCtx();
  try {
    const selection = select(ctx, { policies: ['open', 'restricted'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'succeeded');
    for (const ex of state.executions) {
      const b = JSON.parse(readFileSync(join(ctx.dirs.runs, state.run_id, 'boundaries', `${ex.execution_id}.json`), 'utf8'));
      assert.equal(b.schema, 'single-action-boundaries-1');
      assert.deepEqual([b.run_id, b.execution_id, b.conversation_id], [state.run_id, ex.execution_id, ex.conversation_id]);
      assert.ok(b.task_start_utc <= b.task_finish_utc);
      assert.ok(b.log_before.line_count < b.log_after.line_count, 'the boundary before the task precedes the boundary after it');
      assert.deepEqual([b.policy_before, b.policy_after], [null, null], 'never invented');
    }
  } finally { done(); }
});

test('the policy fingerprint is read just before the task and just after the Agent, and saved in the boundaries; an unreadable fingerprint is null', async () => {
  let reads = 0;
  const { ctx, done } = makeCtx({ policyBoundary: async () => { reads++; return { version: 3, hash: reads === 1 ? 'hash-before' : 'hash-after' }; } });
  try {
    const selection = select(ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    const ex = state.executions[0];
    const b = JSON.parse(readFileSync(join(ctx.dirs.runs, state.run_id, 'boundaries', `${ex.execution_id}.json`), 'utf8'));
    assert.deepEqual(b.policy_before, { version: 3, hash: 'hash-before' });
    assert.deepEqual(b.policy_after, { version: 3, hash: 'hash-after' });
    assert.equal(reads, 2, 'exactly two reads per execution: before the task and after the Agent');
  } finally { done(); }
  const none = makeCtx({ policyBoundary: async () => null });
  try {
    const selection = select(none.ctx, { policies: ['open'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(none.ctx, await createPreview(none.ctx, selection), selection);
    const b = JSON.parse(readFileSync(join(none.ctx.dirs.runs, state.run_id, 'boundaries', `${state.executions[0].execution_id}.json`), 'utf8'));
    assert.deepEqual([b.policy_before, b.policy_after], [null, null], 'never invented');
  } finally { none.done(); }
});

test('a Single-Action Policy Test that breaks its own rules stops the collection after saving its Bundle, and keeps its Sandbox', async () => {
  for (const reason of ['No Tool Call occurred', '2 Tool Calls occurred; exactly one is allowed', 'The applied policy changed during the execution', '3 OpenShell event(s) were dropped']) {
    const { ctx, items, done } = makeCtx({ assess: () => ({ stop: [reason], routing: 'excluded', openshell_policy_decision: null, task_result: 'TASK_FAILED', action_result_after_openshell: 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED', reasons: [reason] }) });
    try {
      const selection = select(ctx, { policies: ['open', 'balanced', 'restricted'], taskIds: ['alpha-task'], categories: ['web-research'] });
      const state = await RUN(ctx, await createPreview(ctx, selection), selection);
      assert.equal(state.status, 'failed', reason);
      assert.match(state.failed.error, /stop condition/);
      assert.ok(state.failed.error.includes(reason));
      assert.ok(state.executions[0].capture_id, 'its Bundle was saved first');
      assert.deepEqual(state.executions.slice(1).map(e => e.status), ['pending', 'pending'], 'the next executions did not start');
      assert.ok(items.some(i => i.id === state.executions[0].conversation_id), 'the Sandbox was kept');
    } finally { done(); }
  }
  // an execution with no explicit decision is not a stop condition: it goes to review and the collection goes on
  const { ctx, done } = makeCtx({ assess: () => ({ stop: [], routing: 'needs_review', openshell_policy_decision: null, task_result: 'TASK_FAILED', action_result_after_openshell: 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED', reasons: ['No explicit OpenShell decision was observed.'] }) });
  try {
    const selection = select(ctx, { policies: ['open', 'balanced'], taskIds: ['alpha-task'], categories: ['web-research'] });
    const state = await RUN(ctx, await createPreview(ctx, selection), selection);
    assert.equal(state.status, 'succeeded');
  } finally { done(); }
});