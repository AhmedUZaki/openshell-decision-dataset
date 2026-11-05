// The collector behind Generate Dataset.cmd: preview, confirmation, one isolated environment per execution, evidence, resume and the final
// processing. Everything that touches the system (panel API, WSL, Docker, child processes, clock) comes in through `ctx`, so tests drive the
// whole workflow with mocks and temporary folders.
//
//   Selected Task -> Selected Policy -> Separate Run -> new Conversation -> new Sandbox -> apply policy -> send the task text
//   -> the Agent works (any tools) -> collect every OpenShell event of that Sandbox -> save raw and sanitized evidence
//   -> save and verify the bundle -> close and delete the Sandbox -> next execution
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, appendFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256, canonicalJson, PROTOCOL_VERSION } from '../../tools/events-panel/provenance.mjs';
import { verifyRaw, verifySanitized, evidenceDir, folderBytes } from '../../tools/events-panel/evidence.mjs';
import { latestDatasetDir } from '../create-dataset/dataset-location.mjs';
import { calculate, planExecutions, selectionHash, formatCalculation, POLICIES } from './collection-selection.mjs';

export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const STAGES = ['Preparing', 'Creating Conversation', 'Creating Sandbox', 'Applying Policy', 'Waiting for Sandbox', 'Sending Task', 'Agent Executing', 'Stabilizing OpenShell Events',
  'Saving Raw Evidence', 'Sanitizing Evidence', 'Saving Bundle', 'Verifying Bundle', 'Closing Sandbox', 'Creating Dataset', 'Complete'];
// The one final step creates the Safety Router Dataset of Single-Action Policy Tests: it builds, validates, verifies independently and saves it in a new timestamped folder under .local/safety-router/datasets/.`nexport const FINAL_STEPS = [['Creating Dataset', ['safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs']]];
export const FINAL_STEPS = [['Creating Dataset', ['safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs']]];
export const BOUNDARIES_SCHEMA = 'single-action-boundaries-1';
// The log boundaries and times of one execution, kept beside the run (never inside a Bundle). Missing values are null, never invented.
export function writeBoundaries(ctx, runId, ex, conversationId, b) {
  const dir = resolve(ctx.dirs.runs, runId, 'boundaries');
  mkdirSync(dir, { recursive: true });
  const doc = { schema: BOUNDARIES_SCHEMA, run_id: runId, execution_id: ex.execution_id, conversation_id: conversationId, sandbox_id: ex.sandbox_id ?? null,
    task_start_utc: b.start, task_finish_utc: b.finish, log_before: b.before, log_after: b.after, policy_before: b.policyBefore ?? null, policy_after: b.policyAfter ?? null };
  const file = resolve(dir, `${ex.execution_id}.json`);
  if (existsSync(file)) renameSync(file, `${file}.attempt-${ex.attempts - 1}`);   // an earlier attempt's record is moved aside, never overwritten
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
  return doc;
}
export const POST_RUN_SECONDS = { base: 60, per_execution: 2 };
const SANDBOX_BYTES = 2 ** 30, MIN_FREE_BYTES = 15 * 2 ** 30, MAX_SANDBOXES = 4;
const MAX_TAIL = 60, MAX_LINE = 400;
export const REQUIRED_FILES = ['setup/pins.env', 'safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/verify-single-action-policy-tests.mjs', 'safety-router-dataset/collect-data/task-catalog.mjs', 'safety-router-dataset/collect-data/collection-runner.mjs', 'safety-router-dataset/task-catalog/catalog.json', 'tools/events-panel/panel-service.mjs', 'tools/events-panel/conversations.mjs', 'tools/events-panel/evidence.mjs'];

const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const clip = (text, n = MAX_LINE) => String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\n]+/g, ' ').slice(0, n);
const policyLabel = id => POLICIES.find(p => p.id === id)?.label ?? id;
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const RUN_ID = /^run-\d{8}T\d{6}-[a-f0-9]{4}$/;

// Conversation sandboxes that exist as containers but are not in the panel's list: leftovers from a stopped run.
export function orphanSandboxes(containerNames, knownIds) {
  const known = new Set(knownIds);
  return [...new Set(containerNames.map(n => /conv-[a-f0-9]{10,12}/.exec(n)?.[0]).filter(Boolean))].filter(id => !known.has(id));
}
export function shellScript(id, task) {
  const message = String(task).replaceAll("'", "'\\''");
  return `export PATH=$HOME/.local/bin:$PATH NEMOCLAW_DISABLE_TELEMETRY=1\nnemoclaw ${id} exec --timeout 400 -- openclaw agent --session-key agent:main:main --json --timeout 300 -m '${message}' 2>&1 | grep -E '"status"|"summary"'\n`;
}

// ---- estimates -------------------------------------------------------------------------------------------------------------------
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

// Seconds per finished execution by policy, from earlier collections.
export function readHistory(runsDir) {
  const samples = [];
  if (!existsSync(runsDir)) return samples;
  for (const n of readdirSync(runsDir)) {
    const state = readJson(resolve(runsDir, n, 'state.json'));
    for (const e of state?.executions || []) if (e.status === 'completed' && e.seconds > 5 && e.seconds < 7200) samples.push({ policy: e.policy, seconds: e.seconds });
  }
  return samples;
}

// Expected seconds for one execution: earlier runs under the same policy when there are any, else the task's own estimate.
export function executionSeconds(ex, estimatedMinutes, history) {
  const pool = history.filter(h => h.policy === ex.policy).map(h => h.seconds).sort((a, b) => a - b);
  if (pool.length) return { seconds: pool.reduce((a, b) => a + b, 0) / pool.length, n: pool.length, basis: `earlier ${policyLabel(ex.policy)} executions`, spread: pool.length >= 3 ? [percentile(pool, 0.25), percentile(pool, 0.75)] : null };
  return { seconds: estimatedMinutes * 60, n: 0, basis: "the tasks' own estimated_minutes (no earlier run under this policy)", spread: null };
}

// An estimate, never a promise. Guarantee: 0 <= low <= estimate <= high.
export function estimate(executions, minutesOf, history) {
  const parts = executions.map(ex => executionSeconds(ex, minutesOf(ex.task_id), history));
  const tasks = parts.reduce((a, p) => a + p.seconds, 0);
  const after = executions.length ? POST_RUN_SECONDS.base + POST_RUN_SECONDS.per_execution * executions.length : 0;
  const est = Math.round(tasks + after);
  const low = parts.reduce((a, p) => a + (p.spread ? p.spread[0] : p.seconds * 0.6), 0) + after;
  const high = parts.reduce((a, p) => a + (p.spread ? p.spread[1] : p.seconds * 1.4), 0) + after;
  return {
    estimated_seconds: est, low_seconds: Math.max(0, Math.min(Math.round(low), est)), high_seconds: Math.max(Math.round(high), est), post_run_seconds: after, one_sandbox_at_a_time: true,
    basis: [...new Set(parts.map(p => `${p.basis}${p.n ? ` (${p.n})` : ''}`))],
    note: 'An estimate, not a promise. Sandbox creation and the Agent vary a lot; the range is likely, not certain.',
  };
}

const range = (n, lo, hi) => ({ estimate: Math.round(n), low: Math.floor(n * lo), high: Math.ceil(n * hi) });
// What earlier collections suggest about size and yield. `stats` comes from the bundles already saved (or defaults).
export function estimateVolumes(total, stats, freeBytes) {
  const s = { avg_events: 45, decision_ratio: 0.25, avg_bundle_bytes: 150 * 1024, avg_evidence_bytes: 120 * 1024, ...stats };
  const perExecution = s.avg_bundle_bytes + s.avg_evidence_bytes;
  const estBytes = SANDBOX_BYTES + total * perExecution;
  const lowBytes = SANDBOX_BYTES + total * perExecution * 0.5, highBytes = SANDBOX_BYTES + total * perExecution * 2;
  const required = Math.max(MIN_FREE_BYTES, highBytes + 5 * 2 ** 30);
  const events = range(total * s.avg_events, 0.5, 2);
  return {
    raw_events: events,
    explicit_decision_events: { estimate: Math.round(events.estimate * s.decision_ratio), low: Math.floor(events.low * Math.max(0, s.decision_ratio - 0.1)), high: Math.ceil(events.high * Math.min(1, s.decision_ratio + 0.15)) },
    disk: { estimated_bytes: Math.round(estBytes), low_bytes: Math.round(lowBytes), high_bytes: Math.round(highBytes), available_bytes: freeBytes, required_free_bytes: Math.round(required), ok: freeBytes >= required,
      note: 'One sandbox (about 1 GB) exists at a time; the rest is the saved bundles and raw and sanitized evidence.' },
    basis: s.bundles ? `${s.bundles} saved bundle(s)` : 'default assumptions (no saved bundles to learn from)',
  };
}

// ---- preflight -------------------------------------------------------------------------------------------------------------------
async function collectionChecks(ctx, selection, remaining, catalog, volumes) {
  const out = [];
  const check = (name, status, detail) => out.push({ name, status, detail });
  check('task catalog is valid', catalog.ok ? 'PASS' : 'FAIL', catalog.ok ? `${catalog.selectable.length} selectable task(s) in ${catalog.categories.length} categories` : `${catalog.errors.length} error(s): ${catalog.errors.slice(0, 2).join('; ')}`);
  const changed = selection.tasks.filter(t => { const c = catalog.selectable.find(x => x.task_id === t.task_id); return !c || c.version !== t.task_version || c.hash !== t.task_hash; });
  check('selected task ids, versions and hashes match the catalog', changed.length ? 'FAIL' : 'PASS', changed.length ? `changed or no longer selectable: ${changed.slice(0, 5).map(t => t.task_id).join(', ')}` : `${selection.tasks.length} task(s) verified`);
  check('selection is not empty', remaining.length ? 'PASS' : 'FAIL', remaining.length ? `${remaining.length} execution(s) to run` : 'nothing to run (every execution is already complete)');
  const active = activeRun(ctx);
  check('no active collection run', active && !active.stale ? 'FAIL' : 'PASS', active && !active.stale ? `run ${active.run_id} is active` : active?.stale ? `a stale lock from ${active.run_id} will be cleared` : 'none');
  const ev = ctx.evidenceStatus();
  check('raw evidence directory', ev.ok ? 'PASS' : 'FAIL', ev.detail);
  const ignore = ctx.readText('.gitignore') ?? '';
  const excluded = ignore.split(/\r?\n/).some(l => /^\/?\.local\/?\*?$/.test(l.trim()));
  check('private raw evidence is excluded from Git', excluded ? 'PASS' : 'FAIL', excluded ? '.local/ is ignored by Git' : '.gitignore does not exclude .local/, which holds .local/evidence/raw/');
  check('disk space', volumes.disk.ok ? 'PASS' : 'FAIL', `${(volumes.disk.available_bytes / 2 ** 30).toFixed(1)} GB free, at least ${(volumes.disk.required_free_bytes / 2 ** 30).toFixed(1)} GB needed`);
  const missing = REQUIRED_FILES.filter(f => !ctx.fileExists(f));
  check('required project files', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_FILES.length} present`);
  check('selected policies', selection.policies.every(p => POLICIES.some(x => x.id === p)) ? 'PASS' : 'FAIL', selection.policies.map(policyLabel).join(', ') + " (NemoClaw's own defaults, no hand-written rules)");
  return out;
}

// ---- preview -----------------------------------------------------------------------------------------------------------------------
export const catalogHashFor = selection => sha256(canonicalJson(selection.tasks.map(t => [t.task_id, t.task_version, t.task_hash])));

// Everything the person sees before confirming. For a resume, `resume` is the saved run: its completed executions are skipped.
export async function buildPreview(ctx, selection, { resume = null } = {}) {
  const catalog = ctx.catalog();
  const runId = resume?.run_id ?? 'run-preview';
  const all = planExecutions(selection, runId);
  const doneIds = new Set(resume ? completedIds(ctx, resume) : []);
  const remaining = all.filter(e => !doneIds.has(e.execution_id));
  const calc = calculate(selection);
  const minutes = id => catalog.tasks.find(t => t.task_id === id)?.estimated_minutes ?? 3;
  const est = estimate(remaining, minutes, readHistory(ctx.dirs.runs));
  const volumes = estimateVolumes(remaining.length, ctx.historyStats?.() ?? {}, ctx.freeBytes());
  const checks = [...await collectionChecks(ctx, selection, remaining, catalog, volumes), ...await ctx.systemChecks(selection, remaining)];
  const blockers = checks.filter(c => c.status === 'FAIL').map(c => `${c.name}: ${c.detail}`);
  const warnings = [
    'Estimates are not promises: time, disk and event counts depend on the Agent, the network and the models.',
    'Every execution is independent. The Agent may choose different tools or commands each time, so this measures real Agent behavior; it does not prove that a policy is the only variable.',
    'A Single-Action Policy Test is accepted for training only when exactly one tool call happened, the policy did not change and OpenShell logged an explicit ALLOWED or DENIED event during the action; every other execution is kept and excluded with its reason.',
    'Network only: OpenShell logs no filesystem verdict, so no filesystem sample is produced.',
    ...checks.filter(c => c.status === 'WARN').map(c => `${c.name}: ${c.detail}`),
  ];
  if (selection.tasks.some(t => catalog.tasks.find(x => x.task_id === t.task_id)?.external_dependency === 'live_external')) warnings.push('Tasks that reach live public endpoints depend on DNS, certificates and remote content that can change.');
  return {
    selection, selection_hash: selectionHash(selection), catalog_hash: catalogHashFor(selection), resume_run_id: resume?.run_id ?? null, protocol_version: PROTOCOL_VERSION,
    calculation: calc, completed_skipped: all.length - remaining.length, remaining: remaining.length, remaining_execution_ids: remaining.map(e => e.execution_id),
    estimate: est, volumes, preflight: checks, blockers, warnings, can_start: remaining.length > 0 && blockers.length === 0,
  };
}

const previewFile = (ctx, id) => resolve(ctx.dirs.previews, `${id}.json`);
// A short-lived record bound to the exact normalized selection. It creates no conversation, sandbox or execution.
export async function createPreview(ctx, selection, opts = {}) {
  const preview = await buildPreview(ctx, selection, opts);
  mkdirSync(ctx.dirs.previews, { recursive: true });
  for (const n of readdirSync(ctx.dirs.previews)) { const f = resolve(ctx.dirs.previews, n); const p = readJson(f); if (!p || Date.parse(p.expires_at) < ctx.now()) rmSync(f, { force: true }); }
  const id = ctx.rand(16);
  const stored = { ...preview, preview_id: id, created_at: new Date(ctx.now()).toISOString(), expires_at: new Date(ctx.now() + PREVIEW_TTL_MS).toISOString() };
  writeFileSync(previewFile(ctx, id), JSON.stringify(stored, null, 2));
  return stored;
}
export function loadPreview(ctx, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) throw Error('The preview id is not valid.');
  const p = readJson(previewFile(ctx, id));
  if (!p) throw Error('There is no such preview (it was already used, or never existed). Preview again.');
  if (Date.parse(p.expires_at) < ctx.now()) { rmSync(previewFile(ctx, id), { force: true }); throw Error('This preview expired (previews last 5 minutes). Preview again.'); }
  return p;
}

// ---- run state, lock, log ----------------------------------------------------------------------------------------------------------
const lockFile = ctx => resolve(ctx.dirs.runs, 'active-run.json');
export function activeRun(ctx) {
  const lock = readJson(lockFile(ctx));
  if (!lock) return null;
  return ctx.pidAlive(lock.pid) ? lock : { ...lock, stale: true };
}
function acquireLock(ctx, lock) {
  mkdirSync(ctx.dirs.runs, { recursive: true });
  const existing = activeRun(ctx);
  if (existing && !existing.stale) throw Error(`Another collection is active (${existing.run_id}). Only one can run at a time.`);
  if (existing?.stale) rmSync(lockFile(ctx), { force: true });
  try { writeFileSync(lockFile(ctx), JSON.stringify(lock), { flag: 'wx' }); } catch { throw Error('Another collection just started. Only one can run at a time.'); }
}
const releaseLock = (ctx, runId) => { const l = readJson(lockFile(ctx)); if (l?.run_id === runId) rmSync(lockFile(ctx), { force: true }); };
const runDir = (ctx, runId) => { if (!RUN_ID.test(runId)) throw Error('The run id is not valid.'); return resolve(ctx.dirs.runs, runId); };
export const readRun = (ctx, runId) => readJson(resolve(runDir(ctx, runId), 'state.json'));
export const cancelFile = (ctx, runId) => resolve(runDir(ctx, runId), 'cancel');
export function requestCancel(ctx) {
  const lock = activeRun(ctx);
  if (!lock || lock.stale) throw Error('There is no active collection to cancel.');
  mkdirSync(runDir(ctx, lock.run_id), { recursive: true });
  writeFileSync(cancelFile(ctx, lock.run_id), new Date(ctx.now()).toISOString());
  return { run_id: lock.run_id, note: 'The collection stops after the execution in progress has saved its evidence and closed its sandbox. It never stops in the middle of an execution.' };
}

// Was the task already sent to the Agent in the environment this execution last created? Read from the run log: a 'sent' event after the
// execution's last 'created' event for that conversation. If it was, the Agent acted and its evidence must be recovered, never sent again.
export function taskWasSent(ctx, runId, executionId, conversationId) {
  let on = false, sent = false;
  try {
    for (const l of readFileSync(resolve(runDir(ctx, runId), 'run.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.execution_id !== executionId) continue;
      if (e.event === 'created') { on = String(e.message ?? '').startsWith(`${conversationId} `); sent = false; }
      else if (e.event === 'sent' && on) sent = true;
    }
  } catch { return false; }
  return sent;
}

// Collections that can be resumed: failed, cancelled, or interrupted (still marked running, but nothing holds the lock).
export function listResumable(ctx) {
  if (!existsSync(ctx.dirs.runs)) return [];
  const lock = activeRun(ctx);
  const out = [];
  for (const n of readdirSync(ctx.dirs.runs).filter(x => RUN_ID.test(x)).sort().reverse()) {
    const s = readRun(ctx, n);
    if (s?.kind !== 'collection') continue;
    const status = s.status === 'running' && !(lock && !lock.stale && lock.run_id === n) ? 'interrupted' : s.status;
    if (!['failed', 'cancelled', 'interrupted'].includes(status)) continue;
    out.push({ run_id: n, status, started_at: s.started_at, total: s.executions.length, completed: s.executions.filter(e => e.status === 'completed').length, selection: s.selection });
  }
  return out;
}

// An execution counts as complete only if its bundle and both evidence layers verify on disk. An exported sample count of zero does not matter:
// a complete bundle with no explicit decision is a completed execution.
export function executionIntact(ctx, ex) {
  if (!ex.capture_id) return { ok: false, failures: ['no capture id was recorded'] };
  const failures = [];
  const bundle = ctx.bundleStatus(ex.capture_id);
  if (!bundle.complete) failures.push(`the bundle is incomplete (missing ${bundle.missing.join(', ')})`);
  try {
    const raw = verifyRaw({ root: ctx.root, runId: ex.run_id, executionId: ex.execution_id });
    if (!raw.ok) failures.push(...raw.failures.map(f => `raw evidence: ${f}`));
    const san = verifySanitized({ root: ctx.root, runId: ex.run_id, executionId: ex.execution_id });
    if (!san.ok) failures.push(...san.failures.map(f => `sanitized evidence: ${f}`));
  } catch (e) { failures.push(e.message); }
  return { ok: failures.length === 0, failures };
}
const completedIds = (ctx, state) => state.executions.filter(e => e.status === 'completed' && executionIntact(ctx, { ...e, run_id: state.run_id }).ok).map(e => e.execution_id);

// What a resume would do, read from the saved run: nothing is created. The catalog hashes must still match.
export function resumePlan(ctx, runId) {
  const state = readRun(ctx, runId);
  if (state?.kind !== 'collection') throw Error('That is not a saved collection.');
  const catalog = ctx.catalog();
  const changed = state.selection.tasks.filter(t => { const c = catalog.selectable.find(x => x.task_id === t.task_id); return !c || c.version !== t.task_version || c.hash !== t.task_hash; });
  const done = completedIds(ctx, state);
  return { state, selection: state.selection, catalog_changed: changed.map(t => t.task_id), completed: done.length, remaining: state.executions.length - done.length, total: state.executions.length };
}

// ---- running -----------------------------------------------------------------------------------------------------------------------
// Starts a collection from a preview, or resumes one. Nothing starts unless `confirmation` is exactly RUN, the preview is unexpired and unused,
// matches the selection and the current task hashes, and preflight passes again right now.
export async function startCollection(ctx, { previewId, confirmation, selection, resumeRunId = null }) {
  if (confirmation !== 'RUN') throw Error('Confirmation must be exactly RUN.');
  const preview = loadPreview(ctx, previewId);
  if (selectionHash(selection) !== preview.selection_hash) throw Error('The selection changed since the preview. Preview again.');
  if ((preview.resume_run_id ?? null) !== resumeRunId) throw Error('The preview was made for a different collection. Preview again.');
  let resume = null;
  if (resumeRunId) {
    const plan = resumePlan(ctx, resumeRunId);
    if (plan.catalog_changed.length) throw Error(`These tasks changed since the collection started, so it cannot be resumed: ${plan.catalog_changed.join(', ')}. Start a new collection.`);
    resume = plan.state;
  }
  const fresh = await buildPreview(ctx, selection, { resume });
  if (fresh.catalog_hash !== preview.catalog_hash) throw Error('The task catalog changed since the preview. Preview again.');
  if (JSON.stringify(fresh.remaining_execution_ids) !== JSON.stringify(preview.remaining_execution_ids)) throw Error('What remains to run changed since the preview. Preview again.');
  if (fresh.blockers.length) throw Error(`Preflight failed: ${fresh.blockers.join('; ')}`);
  const runId = resumeRunId ?? `run-${stamp(new Date(ctx.now()))}-${ctx.rand(2)}`;
  acquireLock(ctx, { run_id: runId, pid: ctx.pid, started_at: new Date(ctx.now()).toISOString() });
  rmSync(previewFile(ctx, previewId), { force: true });
  try { return await executeCollection(ctx, { runId, selection, preview: fresh, previewId, resume }); }
  finally { releaseLock(ctx, runId); }
}

const emptyCounts = () => ({ raw_events: 0, preserved: 0, dropped: 0, explicit_allow: 0, explicit_deny: 0, without_label: 0, bytes: 0 });

export const TASK_OUTCOMES = ['Succeeded', 'Failed', 'Partial', 'Unknown'];
// Collection status (did the evidence get saved and verified?) is kept apart from the tool execution outcome (how did the Agent's tool calls end?; stored as task_outcome).
export function totalsOf(executions) {
  const t = { ...emptyCounts(), completed: 0, failed: 0, bundles: 0, task_outcomes: Object.fromEntries(TASK_OUTCOMES.map(o => [o, 0])), truncated_evidence: 0 };
  for (const e of executions) {
    if (e.status === 'failed') t.failed++;
    if (e.status !== 'completed') continue;
    t.completed++; t.bundles++;
    t.task_outcomes[TASK_OUTCOMES.includes(e.task_outcome) ? e.task_outcome : 'Unknown']++;
    if (e.evidence_completeness === 'Truncated') t.truncated_evidence++;
    for (const k of Object.keys(emptyCounts())) t[k] += e.counts?.[k] ?? 0;
  }
  return t;
}

// The identifiers saved together for one execution (also written into its bundle).
const identity = (ex, extra = {}) => ({ collection_run_id: ex.run_id, execution_id: ex.execution_id, task_id: ex.task_id, task_version: ex.task_version, task_hash: ex.task_hash, category: ex.category, policy: ex.policy, separate_run: ex.separate_run, ...extra });

// Checks one saved execution against what was asked for, independently of what the save call said.
export function verifyExecution(ctx, ex, { conversationId, saved }) {
  const failures = [];
  const bundle = ctx.bundleStatus(saved.captureId);
  if (!bundle.complete) failures.push(`the bundle is incomplete (missing ${bundle.missing.join(', ')})`);
  const doc = ctx.readExecutionFile(saved.captureId);
  if (!doc) failures.push('the bundle has no execution.json');
  else {
    const want = identity(ex);
    for (const [k, v] of Object.entries(want)) if (doc[k] !== v) failures.push(`execution.json ${k} is ${JSON.stringify(doc[k])}, expected ${JSON.stringify(v)}`);
    if (doc.conversation_id !== conversationId) failures.push('execution.json names another conversation');
    if (!doc.sandbox_id) failures.push('execution.json has no sandbox id');
    if (doc.capture_id !== saved.captureId) failures.push('execution.json names another capture');
    if (doc.experiment_mode !== 'autonomous_agent' || doc.experiment_mode_source !== 'recorded') failures.push('execution.json does not record the autonomous experiment mode');
    if (doc.task_source !== 'task_catalog') failures.push('execution.json does not record the task catalog as the task source');
    if (!TASK_OUTCOMES.includes(doc.task_outcome?.value)) failures.push('execution.json records no tool execution outcome');
    if (!['Complete', 'Truncated'].includes(doc.evidence_completeness)) failures.push('execution.json records no evidence completeness');
  }
  const raw = verifyRaw({ root: ctx.root, runId: ex.run_id, executionId: ex.execution_id });
  if (!raw.ok) failures.push(...raw.failures.map(f => `raw evidence: ${f}`));
  const san = verifySanitized({ root: ctx.root, runId: ex.run_id, executionId: ex.execution_id });
  if (!san.ok) failures.push(...san.failures.map(f => `sanitized evidence: ${f}`));
  if (doc && raw.ok && doc.evidence_completeness !== (raw.manifest.evidence_completeness ?? 'Complete')) failures.push('execution.json and the raw manifest disagree about evidence completeness');
  if (doc?.evidence && raw.ok && san.ok) {
    if (doc.evidence.raw_manifest_sha256 !== raw.manifest_sha256) failures.push('the bundle records another raw manifest than the one on disk');
    if (doc.evidence.sanitized_manifest_sha256 !== san.manifest_sha256) failures.push('the bundle records another sanitized manifest than the one on disk');
  } else if (!doc?.evidence) failures.push('the bundle does not reference its evidence');
  return { ok: failures.length === 0, failures, raw, sanitized: san, doc };
}

async function executeCollection(ctx, { runId, selection, preview, previewId, resume }) {
  const dir = runDir(ctx, runId);
  mkdirSync(dir, { recursive: true });
  const logFile = resolve(dir, 'run.jsonl');
  const catalog = ctx.catalog();
  const titles = new Map(catalog.tasks.map(t => [t.task_id, t]));
  const cats = new Map(catalog.categories.map(c => [c.id, c.title]));
  const planned = planExecutions(selection, runId).map(e => ({ ...e, run_id: runId }));
  const startedMs = ctx.now();
  const state = resume ?? {
    kind: 'collection', run_id: runId, selection, selection_hash: preview.selection_hash, catalog_hash: preview.catalog_hash, protocol_version: PROTOCOL_VERSION,
    experiment_mode: 'autonomous_agent', calculation: preview.calculation, started_at: new Date(startedMs).toISOString(),
    executions: planned.map(e => ({ ...e, status: 'pending', attempts: 0, conversation_id: null, sandbox_id: null, capture_id: null, started_at: null, finished_at: null, seconds: null, counts: null, error: null, stage: null })),
  };
  Object.assign(state, { status: 'running', stage: 'Preparing', preview_id: previewId, updated_at: null, elapsed_seconds: 0, failed: null, resume_command: null, cancelled: false,
    resumes: (state.resumes ?? 0) + (resume ? 1 : 0), current: null, message: 'Starting.', tail: [], log: logFile, final: { dataset: 'pending' }, report: null });
  // Executions the earlier run finished stay finished only if their evidence still verifies; the rest are run again as new executions in new environments.
  if (resume) for (const e of state.executions) if (e.status === 'completed' && !executionIntact(ctx, e).ok) e.status = 'pending';
  const todo = state.executions.filter(e => e.status !== 'completed');
  const done0 = state.executions.length - todo.length;
  const save = () => {
    state.updated_at = new Date(ctx.now()).toISOString(); state.elapsed_seconds = Math.round((ctx.now() - startedMs) / 1000);
    state.totals = totalsOf(state.executions);
    writeFileSync(resolve(dir, 'state.json'), JSON.stringify(state, null, 2));
    ctx.onUpdate?.(state);
  };
  const log = e => {
    appendFileSync(logFile, JSON.stringify({ t: new Date(ctx.now()).toISOString(), run_id: runId, ...e }) + '\n');
    state.tail.push(clip(`${e.event.padEnd(8)} ${e.execution_id || ''} ${e.message || ''}`)); if (state.tail.length > MAX_TAIL) state.tail.shift();
    save();
  };
  const stage = (name, ex = null) => { state.stage = name; if (ex) ex.stage = name; save(); };
  log({ event: resume ? 'resume' : 'start', message: `${todo.length} execution(s) to run`, selection, selection_hash: preview.selection_hash, preview_id: previewId, confirmed_at: new Date(ctx.now()).toISOString(), executions: state.executions.length, already_complete: done0 });

  const history = readHistory(ctx.dirs.runs);
  const durations = [];
  const remainingSeconds = left => Math.round(left.reduce((a, e) => a + (durations.length ? durations.reduce((x, y) => x + y, 0) / durations.length : executionSeconds(e, titles.get(e.task_id)?.estimated_minutes ?? 3, history).seconds), 0) + (left.length ? POST_RUN_SECONDS.base + POST_RUN_SECONDS.per_execution * left.length : 0));
  state.remaining_seconds = remainingSeconds(todo);
  let failed = null, cancelled = false;
  // What a verified, saved execution contributes to the run: its outcome, evidence completeness and counts.
  const recordSaved = (ex, v, captureId) => {
    ex.task_outcome = v.doc.task_outcome.value; ex.evidence_completeness = v.doc.evidence_completeness;
    const rawCounts = v.raw.manifest.counts;
    const capture = readJson(resolve(v.raw.dir, 'capture.json'), {});
    const preserved = rawCounts.total, nonBlank = (capture.line_count ?? 0) - (capture.blank_lines ?? 0);
    ex.counts = { ...emptyCounts(), raw_events: rawCounts.total, preserved, dropped: Math.max(0, nonBlank - preserved), explicit_allow: rawCounts.explicit_allow, explicit_deny: rawCounts.explicit_deny, without_label: rawCounts.without_decision,
      bytes: folderBytes(v.raw.dir) + folderBytes(v.sanitized.dir) + (ctx.bundleBytes?.(captureId) ?? 0) };
    log({ event: 'saved', execution_id: ex.execution_id, message: `${captureId} raw=${rawCounts.total} allow=${rawCounts.explicit_allow} deny=${rawCounts.explicit_deny}` });
  };

  for (const [i, ex] of todo.entries()) {
    if (existsSync(cancelFile(ctx, runId))) { cancelled = true; break; }
    const t0 = ctx.now();
    ex.attempts++; ex.status = 'running'; ex.error = null; ex.started_at = new Date(t0).toISOString();
    state.current = { execution_id: ex.execution_id, category: cats.get(ex.category) ?? ex.category, task_id: ex.task_id, task_title: titles.get(ex.task_id)?.title ?? ex.task_id, task_number: ex.task_number, tasks_total: selection.tasks.length,
      policy: ex.policy, policy_label: policyLabel(ex.policy), policy_number: ex.policy_number, policies_total: selection.policies.length, separate_run: ex.separate_run, runs_total: selection.runs, conversation_id: null, sandbox_id: null };
    state.message = `Execution ${ex.index} of ${state.executions.length}`;
    let id = null, acted = false, closed = false;
    const boundary = { before: null, start: null, finish: null, after: null };
    try {
      stage('Preparing', ex);
      // The task text is read from the catalog now and must still be the version and hash the collection was started with.
      const current = ctx.catalog().tasks.find(x => x.task_id === ex.task_id);
      if (!current || current.version !== ex.task_version || current.hash !== ex.task_hash) throw Error('the task changed since the collection started; the execution was not started');
      // An earlier attempt already ran this execution, saved its Bundle, verified it and assessed it, then stopped (a stop condition such as "No Tool
      // Call occurred", or a failure while closing its Sandbox). The Agent has acted, so the execution is never run a second time: its saved Bundle is the
      // observation and keeps the routing its own assessment gave it. Its environment is closed and the collection goes on. Evidence that no longer
      // verifies is not finished this way; it falls through to the re-run below.
      if (ex.capture_id && ex.assessment) {
        const again = verifyExecution(ctx, ex, { conversationId: ex.conversation_id, saved: { captureId: ex.capture_id } });
        if (again.ok) {
          id = ex.conversation_id; acted = true; state.current.conversation_id = id; state.current.sandbox_id = ex.sandbox_id ?? id;
          recordSaved(ex, again, ex.capture_id);
          stage('Closing Sandbox', ex);
          const l = await ctx.panel('/conversations/list', null);
          if (l.status !== 200) throw Error(`list failed (${l.status}); the sandbox ${id} was kept`);
          if (l.body.items.some(x => x.id === id)) {
            const del = await ctx.panel('/conversations/delete', { id, confirm: true, deleteBundles: false }, { timeout: 700000 });
            if (del.status !== 200 || del.body?.removed !== id) throw Error(`sandbox deletion failed (${del.status}): ${clip(JSON.stringify(del.body), 200)}; the sandbox ${id} may still exist`);
          }
          closed = true;
          log({ event: 'finalized', execution_id: ex.execution_id, message: `${ex.capture_id}: saved by an earlier attempt, not run again; its environment ${id} was closed` });
          ex.status = 'completed'; ex.collection_status = 'Succeeded'; ex.finished_at = new Date(ctx.now()).toISOString(); ex.seconds = Math.round((ctx.now() - t0) / 1000);
          state.remaining_seconds = remainingSeconds(todo.slice(i + 1));
          state.current.sandbox_id = null; save();
          continue;
        }
      }
      // A previous failed attempt left evidence for this execution id: it is moved aside, never overwritten or deleted.
      for (const layer of ['raw', 'sanitized']) {
        const d = evidenceDir(ctx.root, layer, runId, ex.execution_id);
        if (existsSync(d)) renameSync(d, `${d}.attempt-${ex.attempts - 1}`);
      }
      // A previous attempt of this execution may have left its environment behind (its evidence was not saved). The panel allows one environment per
      // execution. If the Agent already received the task there, that environment is recovered: its evidence is saved and verified, the task is never
      // sent a second time. If the task was never sent, the empty environment is closed and a new one is created.
      let item = null, recovered = false;
      if (ex.conversation_id && !ex.capture_id) {
        const l = await ctx.panel('/conversations/list', null);
        const old = l.status === 200 ? l.body.items.find(x => x.id === ex.conversation_id) : null;
        if (old && taskWasSent(ctx, runId, ex.execution_id, ex.conversation_id)) {
          if (old.status !== 'ready' || !old.port) throw Error(`the environment ${old.id} of the previous attempt is not ready (${old.status}); it was kept`);
          item = old; recovered = true; id = old.id; acted = true;
          ex.sandbox_id = old.sandboxId ?? null; state.current.conversation_id = id; state.current.sandbox_id = old.sandboxId ?? id;
          log({ event: 'recovered', execution_id: ex.execution_id, message: `${id}: the task was already sent; its evidence is saved without sending it again` });
        } else if (old) {
          const del = await ctx.panel('/conversations/delete', { id: old.id, confirm: true, deleteBundles: false }, { timeout: 700000 });
          if (del.status !== 200 || del.body?.removed !== old.id) throw Error(`the empty environment ${old.id} of the previous attempt could not be closed (${del.status}); it was kept`);
          log({ event: 'closed', execution_id: ex.execution_id, message: `${old.id}: the previous attempt never sent the task; its empty environment was closed` });
        }
      }
      if (!recovered) {
      stage('Creating Conversation', ex);
      const created = await ctx.panel('/conversations/create', { title: `${titles.get(ex.task_id)?.title ?? ex.task_id} (${policyLabel(ex.policy)}, run ${ex.separate_run})`.slice(0, 120), policyTier: ex.policy,
        taskSource: 'task_catalog', taskId: ex.task_id, expect: { version: ex.task_version, hash: ex.task_hash }, execution: { run_id: runId, execution_id: ex.execution_id, separate_run: ex.separate_run } });
      if (created.status !== 200 || !created.body?.id) throw Error(`create failed (${created.status}): ${clip(JSON.stringify(created.body), 200)}`);
      id = created.body.id; ex.conversation_id = id; state.current.conversation_id = id;
      log({ event: 'created', execution_id: ex.execution_id, message: `${id} ${ex.policy}` });
      stage('Creating Sandbox', ex);
      for (let n = 0; n < ctx.readyPolls; n++) {
        const l = await ctx.panel('/conversations/list', null);
        if (l.status !== 200) throw Error(`list failed (${l.status})`);
        item = l.body.items.find(x => x.id === id);
        if (item && item.status !== 'creating') break;
        await ctx.sleep(ctx.pollMs);
      }
      if (!item || item.status !== 'ready') throw Error(`sandbox not ready: ${clip(JSON.stringify(item), 200)}`);
      ex.sandbox_id = item.sandboxId ?? null; state.current.sandbox_id = item.sandboxId ?? id;
      stage('Applying Policy', ex);
      if (item.policyTier !== ex.policy) throw Error(`the sandbox reports policy ${item.policyTier}, not ${ex.policy}`);
      stage('Waiting for Sandbox', ex);
      if (!item.port) throw Error('the sandbox has no dashboard port');

      // The log boundary before the task: what OpenShell already holds for this Sandbox (setup events) is outside the action window.
      boundary.before = await (ctx.logBoundary?.(id) ?? null);
      boundary.policyBefore = await (ctx.policyBoundary?.(id) ?? null);   // the policy fingerprint just before the task
      boundary.start = new Date(ctx.now()).toISOString();
      acted = true;   // from here on the Agent may have acted: this execution is never started a second time
      stage('Sending Task', ex);
      const sending = ctx.sendTask(id, current.task_text);
      stage('Agent Executing', ex);
      let sent;
      try { sent = await sending; } catch (e) { sent = `ERROR ${clip(e.message, 300)}`; }
      log({ event: 'sent', execution_id: ex.execution_id, message: clip(sent) });
      }

      stage('Stabilizing OpenShell Events', ex);
      let last = -1;
      for (let n = 0; n < ctx.stabilizePolls; n++) {
        await ctx.sleep(ctx.stabilizeMs);
        const count = await ctx.logLineCount(id);
        if (count === last) break;
        last = count;
      }
      // The boundary after the Agent finished and the log stopped growing. Written before the Bundle is saved, bound to this execution only.
      boundary.finish = new Date(ctx.now()).toISOString();
      boundary.after = await (ctx.logBoundary?.(id) ?? null);
      boundary.policyAfter = await (ctx.policyBoundary?.(id) ?? null);   // and just after the Agent finished
      writeBoundaries(ctx, runId, ex, id, boundary);

      stage('Saving Raw Evidence', ex);
      let saved = null;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        const r = await ctx.panel('/conversations/save', { id }, { origin: `http://127.0.0.1:${item.port}`, conversation: '/chat/main', timeout: 400000 });
        if (r.status === 200) { saved = r.body; break; }
        const why = String(r.body?.error || r.body);
        // Only "the agent is not idle yet" is retried: it is a wait for the Agent, not a second action.
        if (!/still active|completion is unconfirmed|changed during export/.test(why)) throw Error(`save failed (${r.status}): ${clip(why, 200)}`);
        log({ event: 'retry', execution_id: ex.execution_id, message: clip(why, 200) }); await ctx.sleep(ctx.retryMs);
      }
      if (!saved?.captureId) throw Error('save failed: the Agent was still not idle after 3 attempts');
      ex.capture_id = saved.captureId;
      stage('Sanitizing Evidence', ex);
      const san = verifySanitized({ root: ctx.root, runId, executionId: ex.execution_id });
      if (!san.ok) throw Error(`the sanitized evidence does not verify: ${san.failures.join('; ')}`);
      stage('Saving Bundle', ex);
      const bundle = ctx.bundleStatus(saved.captureId);
      if (!bundle.complete) throw Error(`the saved bundle ${saved.captureId} is incomplete (missing ${bundle.missing.join(', ')}); the sandbox was kept`);
      stage('Verifying Bundle', ex);
      const v = verifyExecution(ctx, ex, { conversationId: id, saved });
      if (!v.ok) throw Error(`the bundle does not verify: ${v.failures.slice(0, 3).join('; ')}`);
      // A Single-Action Policy Test that broke its own rules stops the whole collection. Its Bundle stays saved and verified; its Sandbox is kept for a look.
      const assessed = ctx.assessExecution?.(saved.captureId);
      if (assessed?.stop?.length) { ex.assessment = assessed; throw Error(`stop condition: ${assessed.stop.join('; ')}`); }
      ex.assessment = assessed ?? null;
      recordSaved(ex, v, saved.captureId);

      stage('Closing Sandbox', ex);
      const del = await ctx.panel('/conversations/delete', { id, confirm: true, deleteBundles: false }, { timeout: 700000 });
      if (del.status !== 200 || del.body?.removed !== id) throw Error(`sandbox deletion failed (${del.status}): ${clip(JSON.stringify(del.body), 200)}; the sandbox ${id} may still exist`);
      const after = await ctx.panel('/conversations/list', null);
      if (after.status !== 200 || after.body.items.some(x => x.id === id)) throw Error(`sandbox ${id} is still listed after deletion`);
      closed = true;
      log({ event: 'closed', execution_id: ex.execution_id, message: id });
      ex.status = 'completed'; ex.collection_status = 'Succeeded'; ex.finished_at = new Date(ctx.now()).toISOString(); ex.seconds = Math.round((ctx.now() - t0) / 1000); durations.push(ex.seconds);
      state.remaining_seconds = remainingSeconds(todo.slice(i + 1));
      state.current.sandbox_id = null; save();
    } catch (e) {
      ex.status = 'failed'; ex.collection_status = 'Failed'; ex.error = clip(e.message, 500); ex.finished_at = new Date(ctx.now()).toISOString();
      const kept = id ? ` The sandbox ${id} was kept${ex.capture_id ? '; its evidence is saved' : ' because its evidence is not saved'}.` : '';
      failed = { execution_id: ex.execution_id, stage: state.stage, sandbox: id, capture_id: ex.capture_id, conversation_id: id, error: ex.error, before_action: !acted, closed };
      log({ event: 'error', execution_id: ex.execution_id, message: clip(e.message, 400) + kept });
      break;
    }
  }
  state.current = failed || cancelled ? state.current : null;
  const stepsOk = !failed && !cancelled;
  if (stepsOk) {
    for (const [name, args] of FINAL_STEPS) {
      const key = 'dataset';
      stage(name); state.final[key] = 'running'; state.message = `Running node ${args.join(' ')}`;
      log({ event: key, message: `node ${args.join(' ')}` });
      const r = await ctx.runNode(args);
      for (const l of String(r.output ?? '').split(/\r?\n/).filter(Boolean).slice(-12)) state.tail.push(clip(l)); state.tail = state.tail.slice(-MAX_TAIL);
      if (r.code !== 0) { state.final[key] = 'failed'; failed = { execution_id: null, stage: name, sandbox: null, capture_id: null, conversation_id: null, error: `node ${args.join(' ')} exited with code ${r.code}`, before_action: false }; log({ event: 'error', message: failed.error }); break; }
      state.final[key] = 'passed'; log({ event: 'ok', message: `${name} passed` });
    }
  }
  for (const k of Object.keys(state.final)) if (state.final[k] === 'pending') state.final[k] = 'skipped';
  state.status = failed ? 'failed' : cancelled ? 'cancelled' : 'succeeded';
  state.failed = failed; state.cancelled = cancelled;
  state.resume_command = failed || cancelled ? `Generate Dataset.cmd  ->  2) Resume a previous collection  ->  ${runId}` : null;
  state.stage = state.status === 'succeeded' ? 'Complete' : state.stage;
  state.message = failed ? `Stopped at ${failed.stage}: ${failed.error}` : cancelled ? 'Cancelled between executions. Saved evidence is kept.' : 'Complete: every execution is saved and the timestamped Dataset is created, validated and independently verified.';
  state.remaining_seconds = 0;
  state.report = buildReport(ctx, state);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(state.report, null, 2));
  log({ event: failed ? 'failed' : cancelled ? 'cancelled' : 'done', message: state.message });
  return state;
}

// ---- the final report ---------------------------------------------------------------------------------------------------------------
export function buildReport(ctx, state) {
  const t = totalsOf(state.executions);
  // The Safety Router Dataset of Single-Action Policy Tests.
  const latest = latestDatasetDir(ctx.root ?? '.');
  const manifest = latest ? readJson(resolve(latest, 'manifest.json')) : null;
  const location = latest ? `.local/safety-router/datasets/${latest.split(/[\\/]/).pop()}/accepted-execution-records.jsonl` : null;
  const ar = manifest?.active_records;
  const od = manifest?.openshell_policy_decisions ?? {};
  const dataset = ar ? { accepted: ar.accepted_count, review: ar.needs_review_count, excluded: ar.excluded_count, training_eligible: ar.training_eligible_count, allowed: od.OPENSHELL_ALLOWED ?? 0, denied: od.OPENSHELL_DENIED ?? 0, missing: od.missing ?? 0, ambiguous: od.ambiguous ?? 0, location } : null;
  const cats = new Map(ctx.catalog().categories.map(c => [c.id, c.title]));
  return {
    run_id: state.run_id, status: state.status, experiment_mode: state.experiment_mode,
    selected: { categories: state.selection.categories.map(id => ({ id, title: cats.get(id) ?? id, tasks: state.selection.tasks.filter(x => x.category === id).length })), tasks: state.selection.tasks.map(x => x.task_id), policies: state.selection.policies, separate_runs: state.selection.runs },
    executions: { planned: state.executions.length, completed: t.completed, failed: t.failed, pending: state.executions.length - t.completed - t.failed },
    // Two separate questions: was the evidence collected, and did the Agent's task work? A failed task with saved evidence is a successful collection.
    collection_status: { succeeded: t.completed, failed: t.failed, not_run: state.executions.length - t.completed - t.failed },
    task_outcomes: t.task_outcomes,
    evidence_completeness: { complete: t.bundles - t.truncated_evidence, truncated: t.truncated_evidence },
    evidence: { bundles: t.bundles, raw_events_total: t.raw_events, raw_events_preserved: t.preserved, raw_events_dropped: t.dropped, explicit_allow_events: t.explicit_allow, explicit_deny_events: t.explicit_deny, events_without_labels: t.without_label },
    // The same figures for each policy, from that policy's executions only, so the three can be compared.
    by_policy: Object.fromEntries(state.selection.policies.map(p => { const x = totalsOf(state.executions.filter(e => e.policy === p)); const planned = state.executions.filter(e => e.policy === p).length;
      return [p, { planned, executions: planned, completed: x.completed, failed: x.failed, not_run: planned - x.completed - x.failed, task_outcomes: x.task_outcomes, evidence_complete: x.bundles - x.truncated_evidence, evidence_truncated: x.truncated_evidence,
        raw_events: x.raw_events, raw_events_dropped: x.dropped, explicit_allow: x.explicit_allow, explicit_deny: x.explicit_deny, without_decision: x.without_label }]; })),
    dataset, final_steps: state.final, duration_seconds: state.elapsed_seconds, disk_bytes: t.bytes,
    outputs: { bundles: '.local/task-captures/', raw_evidence: '.local/evidence/raw/ (private: never publish)', sanitized_evidence: '.local/evidence/sanitized/', run_log: `.local/runs/${state.run_id}/run.jsonl`, dataset: '.local/safety-router/datasets/' },
    failed: state.failed, resume_command: state.resume_command,
  };
}

const mins = s => s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const gb = b => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${(b / 2 ** 20).toFixed(0)} MB`;
const fmtRange = r => `${r.estimate} (range ${r.low} to ${r.high})`;
export function formatReport(r) {
  const L = [];
  L.push(`Collection ${r.run_id}: ${r.status.toUpperCase()}`);
  L.push(`Categories : ${r.selected.categories.map(c => `${c.title} (${c.tasks})`).join(', ')}`);
  L.push(`Tasks      : ${r.selected.tasks.length}   Policies: ${r.selected.policies.map(policyLabel).join(', ')}   Separate runs per task and policy: ${r.selected.separate_runs}`);
  L.push(`Executions : planned ${r.executions.planned}, completed ${r.executions.completed}, failed ${r.executions.failed}, not run ${r.executions.pending}`);
  L.push(`Collection : succeeded ${r.collection_status.succeeded}, failed ${r.collection_status.failed}, not run ${r.collection_status.not_run}   (was the evidence saved and verified?)`);
  L.push(`Tool execution outcome: Succeeded ${r.task_outcomes.Succeeded}, Failed ${r.task_outcomes.Failed}, Partial ${r.task_outcomes.Partial}, Unknown ${r.task_outcomes.Unknown}   (how the tool calls ended; information only, not a label, not proof the task goal was met)`);
  L.push(`Evidence   : complete ${r.evidence_completeness.complete}, truncated ${r.evidence_completeness.truncated}${r.evidence_completeness.truncated ? '   (truncated bundles are withheld from training by default)' : ''}`);
  const e = r.evidence;
  L.push(`Evidence   : bundles ${e.bundles}; raw OpenShell events ${e.raw_events_total} (preserved ${e.raw_events_preserved}, dropped ${e.raw_events_dropped})`);
  L.push(`Decisions  : explicit ALLOW ${e.explicit_allow_events}, explicit DENY ${e.explicit_deny_events}, events without labels ${e.events_without_labels}`);
  L.push('By policy  :');
  for (const [p, x] of Object.entries(r.by_policy ?? {})) {
    L.push(`  ${policyLabel(p)}: planned ${x.planned}, collected ${x.completed}, collection failed ${x.failed}, not run ${x.not_run}; evidence complete ${x.evidence_complete}, truncated ${x.evidence_truncated}`);
    L.push(`      tool execution outcome Succeeded ${x.task_outcomes.Succeeded}, Failed ${x.task_outcomes.Failed}, Partial ${x.task_outcomes.Partial}, Unknown ${x.task_outcomes.Unknown}`);
    L.push(`      raw events ${x.raw_events} (dropped ${x.raw_events_dropped}): explicit ALLOW ${x.explicit_allow}, explicit DENY ${x.explicit_deny}, without decision ${x.without_decision}`);
  }
  L.push('Events     : every OpenShell event is kept in the raw evidence and in the record timeline; events outside the single action are kept apart from those observed during it');
  if (r.dataset) L.push(`Dataset    : Safety Router records: accepted ${r.dataset.accepted}, review ${r.dataset.review}, excluded ${r.dataset.excluded}; OpenShell decisions ALLOWED ${r.dataset.allowed}, DENIED ${r.dataset.denied}, missing ${r.dataset.missing}, ambiguous ${r.dataset.ambiguous}; training-eligible ${r.dataset.training_eligible}`);
  L.push(`Dataset creation (build, validation, independent verification, determinism, timestamped folder): ${r.final_steps.dataset}`);
  L.push(`Duration   : ${mins(r.duration_seconds)}; disk used by this run ${gb(r.disk_bytes)}`);
  L.push(`Outputs    : ${Object.values(r.outputs).join(' | ')}`);
  if (r.failed) L.push(`FAILED at ${r.failed.stage}: ${r.failed.error}${r.failed.sandbox ? ` (sandbox ${r.failed.sandbox} kept)` : ''}`);
  if (r.resume_command) L.push(`Resume     : ${r.resume_command}`);
  return L.join('\n');
}

// ---- preview text ---------------------------------------------------------------------------------------------------------------------
export function formatPreview(p, { catalog } = {}) {
  const L = [];
  const c = p.calculation, s = p.selection;
  const cats = new Map((catalog?.categories ?? []).map(x => [x.id, x.title]));
  L.push(`Categories : ${s.categories.map(id => `${cats.get(id) ?? id} (${c.tasks_by_category[id]})`).join(', ')}`);
  L.push(`Policies   : ${s.policies.map(policyLabel).join(', ')}`);
  L.push(`Separate runs for each task under each policy: ${s.runs}`);
  L.push('');
  L.push(formatCalculation(c));
  L.push('');
  L.push(`Isolated Conversations to create : ${c.conversations}`);
  L.push(`Isolated Sandboxes to create     : ${c.sandboxes}`);
  L.push(`Expected evidence bundles        : ${c.expected_bundles}`);
  L.push(`Executions by policy   : ${Object.entries(c.by_policy).map(([k, v]) => `${policyLabel(k)} ${v}`).join(', ')}`);
  L.push(`Executions by category : ${Object.entries(c.by_category).map(([k, v]) => `${cats.get(k) ?? k} ${v}`).join(', ')}`);
  if (p.resume_run_id) L.push(`Resuming ${p.resume_run_id}: ${p.completed_skipped} complete execution(s) will be skipped, ${p.remaining} remain.`);
  else if (p.completed_skipped) L.push(`Completed executions that will be skipped: ${p.completed_skipped}`);
  const e = p.estimate, v = p.volumes;
  L.push('');
  L.push(`Estimated time : about ${mins(e.estimated_seconds)} (range ${mins(e.low_seconds)} to ${mins(e.high_seconds)}); basis: ${e.basis.join('; ') || '-'}`);
  L.push(`Estimated disk : about ${gb(v.disk.estimated_bytes)} (range ${gb(v.disk.low_bytes)} to ${gb(v.disk.high_bytes)}); ${gb(v.disk.available_bytes)} available`);
  L.push(`Estimated raw OpenShell events      : ${fmtRange(v.raw_events)}`);
  L.push(`Estimated explicit decision events  : ${fmtRange(v.explicit_decision_events)}   (${v.basis})`);
  L.push('Estimates are not promises.');
  L.push('');
  L.push('Preflight (read only):');
  for (const k of p.preflight) L.push(`  ${k.status.padEnd(4)} ${k.name}: ${k.detail}`);
  L.push('');
  for (const w of p.warnings) L.push(`WARNING: ${w}`);
  for (const b of p.blockers) L.push(`BLOCKED: ${b}`);
  return L.join('\n');
}
