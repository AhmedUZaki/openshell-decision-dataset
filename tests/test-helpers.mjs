// Shared test helpers: a mock system and a small catalog in a temporary folder. Nothing here touches Docker, WSL, OpenShell, Ollama, the panel
// service or a real sandbox.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadCatalog } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { buildSelection } from '../safety-router-dataset/collect-data/collection-selection.mjs';
import { bundleEvidence } from '../tools/events-panel/provenance.mjs';
import { writeRawEvidence, writeSanitizedEvidence } from '../tools/events-panel/evidence.mjs';
import { startCollection } from '../safety-router-dataset/collect-data/collection-runner.mjs';
import { testTmp } from './tmp-dir.mjs';

export const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);
export const task = (id, category, over = {}) => ({ schema_version: 1, task_id: id, version: 1, title: `Task ${id}`, description: 'A task that reads a public page for the test.', category,
  task_text: `Read the page at https://example.com/${id} and write a short summary of what is on it.`, tags: ['network'], expected_capabilities: ['network'], external_dependency: 'live_external', estimated_minutes: 3, enabled: true, deprecated: false, safety_notes: [], ...over });
export const TASKS = [task('alpha-task', 'web-research'), task('beta-task', 'web-research'), task('gamma-task', 'api-interaction')];
export const CATS = [{ id: 'web-research', title: 'Web research', description: '', order: 1 }, { id: 'api-interaction', title: 'API interaction', description: '', order: 2 }];
export const LOG = (n = 0) => [
  `[${1793570000 + n}.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(1) -> pypi.org:443 [policy:pypi engine:opa]`,
  `[${1793570001 + n}.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(2) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]`,
  `[${1793570002 + n}.000] [sandbox] [INFO ] [openshell_sandbox] heartbeat token=SECRET123`,
  `[${1793570003 + n}.000] [sandbox] [OCSF ] [ocsf] CONFIG:LOADED [INFO] policy loaded`,
].join('\n') + '\n';
export const NO_DECISIONS = `[1793570000.000] [sandbox] [INFO ] [openshell_sandbox] sandbox started\n[1793570001.000] [sandbox] [OCSF ] [ocsf] CONFIG:LOADED [INFO] policy loaded\n`;

export function makeCtx(over = {}) {
  let boundaryReads = 0;
  const root = testTmp('collector-');
  const dirs = { captures: join(root, '.local/task-captures'), runs: join(root, '.local/runs'), previews: join(root, '.local/dataset-previews') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(root, 'safety-router-dataset/task-catalog'), { recursive: true });
  writeFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), JSON.stringify({ schema_version: 1, categories: CATS, registry: {} }));
  for (const c of CATS) mkdirSync(join(root, 'safety-router-dataset/task-catalog', c.id), { recursive: true });
  const putTask = t => writeFileSync(join(root, 'safety-router-dataset/task-catalog', t.category, `${t.task_id}.json`), JSON.stringify(t));
  for (const t of TASKS) putTask(t);
  const clock = { t: T0 };
  const calls = [], items = [], created = [];
  let open = 0, maxOpen = 0, saves = 0, n = 0;
  const stages = [];
  const panelHandler = over.panel ?? (async (path, body, opts) => {
    if (path === '/conversations/create') {
      if (items.some(i => i.execution?.execution_id === body.execution?.execution_id && i.status === 'ready')) return { status: 400, body: { error: 'An environment for this execution already exists; every execution gets its own.' } };
      const id = `conv-${String(++n).padStart(10, '0')}`;
      items.push({ id, status: 'ready', port: 19000 + n, sandboxId: `sandbox-${n}`, policyTier: body.policyTier, execution: body.execution, taskId: body.taskId, body });
      created.push({ id, body }); open++; maxOpen = Math.max(maxOpen, open);
      return { status: 200, body: { id } };
    }
    if (path === '/conversations/list') return { status: 200, body: { items: items.map(({ body: _b, ...i }) => i) } };
    if (path === '/conversations/save') {
      const item = items.find(i => i.id === body.id);
      if (over.saveError?.(item, ++saves)) return { status: 400, body: { error: over.saveError(item, saves) } };
      const ex = item.execution;
      const text = over.logFor ? over.logFor(ex) : LOG(saves);
      const capture = { started_at: new Date(clock.t).toISOString(), ended_at: new Date(clock.t).toISOString(), openshell_version: '0.0.116', sandbox_id: item.sandboxId, conversation_id: item.id, capture_id: 'x' };
      const captureId = `capture-${randomBytes(12).toString('hex')}`;
      const raw = writeRawEvidence({ root, runId: ex.run_id, executionId: ex.execution_id, text: text, capture: { ...capture, capture_id: captureId } });
      const san = writeSanitizedEvidence({ root, runId: ex.run_id, executionId: ex.execution_id });
      const folder = join(dirs.captures, captureId);
      mkdirSync(join(folder, 'trajectory'), { recursive: true }); mkdirSync(join(folder, 'policy-versions'));
      const tk = item.body.taskId, ct = ctx.catalog().tasks.find(x => x.task_id === tk);
      const put = (f, v) => writeFileSync(join(folder, f), typeof v === 'string' ? v : JSON.stringify(v));
      for (const f of ['manifest.json', 'conversation.json', 'environment.json', 'effective-policy.json']) put(f, {});
      put('task.json', { title: ct.title, experiment_mode: 'autonomous_agent' });
      for (const f of ['tool-calls.jsonl', 'openshell-events.jsonl', 'trajectory/events.jsonl']) put(f, '');
      put('openshell-log-sanitized.txt', san.log);
      const doc = { schema_version: 1, collection_run_id: ex.run_id, execution_id: ex.execution_id, task_source: 'task_catalog', task_id: ct.task_id, task_version: ct.version, task_hash: ct.hash, category: ct.category, policy: item.policyTier, separate_run: ex.separate_run,
        conversation_id: item.id, sandbox_id: item.sandboxId, capture_id: captureId, experiment_mode: 'autonomous_agent', experiment_mode_source: 'recorded',
        evidence_completeness: raw.evidence_completeness, task_outcome: over.taskOutcome ? over.taskOutcome(item, saves) : { value: 'Succeeded', tool_calls: 1, succeeded: 1, failed: 0, without_result: 0 },
        evidence: { run_id: ex.run_id, execution_id: ex.execution_id, raw_dir: `.local/evidence/raw/${ex.run_id}/${ex.execution_id}`, sanitized_dir: `.local/evidence/sanitized/${ex.run_id}/${ex.execution_id}`, raw_manifest_sha256: raw.manifest_sha256, sanitized_manifest_sha256: san.manifest_sha256 } };
      if (over.executionDoc) over.executionDoc(doc);
      put('execution.json', doc);
      return { status: 200, body: { captureId, toolCallCount: 1, eventCount: raw.counts.total } };
    }
    if (path === '/conversations/delete') { const i = items.findIndex(x => x.id === body.id); if (i >= 0) { items.splice(i, 1); open--; } return { status: 200, body: { removed: body.id } }; }
    throw Error(`unexpected panel call ${path}`);
  });
  const ctx = {
    root, dirs, catalog: () => loadCatalog(root), freeBytes: () => over.free ?? 500 * 2 ** 30,
    systemChecks: async () => over.system ?? [{ name: 'system', status: 'PASS', detail: 'ok' }],
    evidenceStatus: () => ({ ok: true, detail: 'writable' }), readText: () => over.gitignore ?? '.local/\n', fileExists: () => over.missingFile ? false : true,
    panel: async (path, body, opts) => { calls.push({ path, body, opts }); return panelHandler(path, body, opts); },
    sendTask: async (id, text) => { calls.push({ send: id, text }); if (over.onSend) await over.onSend(id); return '"status": "ok"'; },
    logLineCount: async () => 10,
    logBoundary: async () => { boundaryReads++; return { line_count: 10 * boundaryReads, cursor: 10 * boundaryReads }; },
    policyBoundary: over.policyBoundary,
    assessExecution: over.assess ? (captureId => over.assess(captureId)) : undefined,
    runNode: async args => { calls.push({ node: args }); return over.runNode ? over.runNode(args) : { code: 0, output: 'ok' }; },
    bundleStatus: captureId => { const f = join(dirs.captures, captureId); const e = bundleEvidence(f); const missing = [...e.missing, ...(existsSync(join(f, 'execution.json')) ? [] : ['execution.json'])]; return over.bundleStatus ? over.bundleStatus(captureId, missing) : { complete: missing.length === 0, missing }; },
    bundleBytes: () => 1000, readExecutionFile: captureId => { try { return JSON.parse(readFileSync(join(dirs.captures, captureId, 'execution.json'), 'utf8')); } catch { return null; } },
    historyStats: () => ({}),
    now: () => clock.t, sleep: async ms => { clock.t += ms; }, rand: k => randomBytes(k).toString('hex'), pid: process.pid, pidAlive: over.pidAlive ?? (pid => pid === process.pid),
    readyPolls: 3, pollMs: 1, retryMs: 1, stabilizeMs: 1, stabilizePolls: 3, onUpdate: s => { if (s.current) stages.push([s.current.execution_id, s.stage]); },
  };
  return { ctx, root, clock, calls, items, created, stages, putTask, maxOpen: () => maxOpen, done: () => rmSync(root, { recursive: true, force: true }) };
}
export const select = (ctx, { policies = ['restricted', 'balanced', 'open'], taskIds = TASKS.map(t => t.task_id), runs = 1, categories = CATS.map(c => c.id) } = {}) => buildSelection({ policies, categories, taskIds, runs }, ctx.catalog());
export const RUN = (ctx, preview, selection, extra = {}) => startCollection(ctx, { previewId: preview.preview_id, confirmation: 'RUN', selection, ...extra });

