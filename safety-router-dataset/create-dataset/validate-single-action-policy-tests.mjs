// Checks Safety Router records of Single-Action Policy Tests: the JSON schema, then the relations a schema cannot state. Command line:
//   node safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs [--root DIR] [file.jsonl ...]
// default: the three files of the newest Dataset folder under .local/safety-router/datasets/. Exit code 1 when anything is invalid or missing.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from './schema-validate.mjs';
import { latestDatasetDir } from './dataset-location.mjs';
import { recordHash, FORBIDDEN_KEYS, FORBIDDEN_VALUES, TASK_CATEGORY, COMPACT_EXCLUDED_KEYS, DECISIONS, TASK_RESULTS, ACTION_RESULTS, proxyTunnel403Refusal } from '../../tools/events-panel/single-action-record.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const schemaPath = () => resolve(here, 'schemas/single-action-policy-test-record.schema.json');
export const OUTPUT_FILES = { accepted: 'accepted-execution-records.jsonl', review: 'needs-review-records.jsonl', excluded: 'excluded-execution-index.jsonl' };
const EXPECTED = { 'accepted-execution-records.jsonl': 'accepted', 'needs-review-records.jsonl': 'needs_review' };
const EXCLUDED_FILE = 'excluded-execution-index.jsonl';

// The schema file uses local $refs; the dependency-free validator does not follow references, so they are inlined here.
export function loadSchema() {
  const doc = JSON.parse(readFileSync(schemaPath(), 'utf8'));
  const defs = { '#/eventRef': doc.eventRef, '#/stamp': doc.stamp };
  const inline = v => Array.isArray(v) ? v.map(inline) : v && typeof v === 'object' ? (v.$ref in defs ? inline(defs[v.$ref]) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inline(x)]))) : v;
  const { eventRef, stamp, ...rest } = doc;
  return inline(rest);
}

// Keys and values that must never appear. The Agent's own tool arguments and the policy snapshot are data, not part of this schema.
export function forbiddenFindings(record) {
  const found = [];
  const walk = (v, path) => {
    if (typeof v === 'string') { if (FORBIDDEN_VALUES.includes(v)) found.push(`${path} holds the value ${v}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.includes(k)) found.push(`${path}.${k} is not allowed in this schema`);
      if (k === 'arguments' || k === 'policy_snapshot' || k === 'tool_result' || k === 'content' || k === 'task_text' || k === 'reason' || k === 'final_reason' || k === 'exclusion_reasons' || k === 'reasons') continue;
      walk(x, `${path}.${k}`);
    }
  };
  walk(record, '$');
  return found;
}

// The only values that may become a binary training label: an observed OPENSHELL_ALLOWED or OPENSHELL_DENIED of an accepted record. Task Result,
// Action Result After OpenShell, the Agent behaviour and the evidence status are evaluation metadata and never a label or a Router input.
export function trainingLabel(record) {
  const d = record?.outcomes?.openshell_policy_decision;
  return record?.routing?.output === 'accepted' && record.routing.training_eligible === true && d?.evidence_status === 'OPENSHELL_DECISION_OBSERVED' && DECISIONS.includes(d.value) ? d.value : null;
}

export function invariantErrors(r, file = null) {
  const errors = [...forbiddenFindings(r)];
  const o = r.outcomes, d = o.openshell_policy_decision, a = o.action_result_after_openshell, c = r.execution_checks, rt = r.routing, tl = r.openshell_timeline, g = r.action_and_policy_events;
  if (r.integrity?.record_hash !== recordHash(r)) errors.push('integrity.record_hash does not match the record');
  if (r.applied_policy.policy_remained_unchanged !== c.policy_remained_unchanged) errors.push('policy_remained_unchanged differs between applied_policy and execution_checks');
  tl.forEach((e, i) => { if (e.sequence !== i + 1) errors.push(`openshell_timeline[${i}] has sequence ${e.sequence}, expected ${i + 1}`); });
  r.agent_timeline.forEach((e, i) => { if (e.sequence !== i + 1) errors.push(`agent_timeline[${i}] has sequence ${e.sequence}, expected ${i + 1}`); });
  for (const [k, s] of Object.entries(r.timestamps)) if (k !== 'timeline_sources' && (s.value === null) !== (s.source === 'not_recorded')) errors.push(`timestamps.${k}: a missing value must say not_recorded and a recorded value must name its source`);
  // every OpenShell event appears exactly once across the two groups
  const seen = new Map();
  for (const list of [g.events_observed_during_action, g.events_outside_action]) for (const e of list) seen.set(e.sequence, (seen.get(e.sequence) ?? 0) + 1);
  for (const e of tl) if (seen.get(e.sequence) !== 1) errors.push(`OpenShell event ${e.sequence} appears ${seen.get(e.sequence) ?? 0} times in the groups; it must appear exactly once`);
  if (seen.size !== tl.length) errors.push('the groups name events that are not in openshell_timeline');
  for (const e of g.events_observed_during_action) if (tl[e.sequence - 1]?.event_origin !== 'agent_task_activity') errors.push(`event ${e.sequence} observed during the action is not agent task activity`);
  // the decision rests on explicit decision events observed during the action, never on anything else
  const observed = new Map(g.events_observed_during_action.map(e => [e.raw_event_reference, tl[e.sequence - 1]]));
  for (const id of d.event_ids) { const e = observed.get(id); if (!e || !e.decision) errors.push(`decision event ${id} is not an explicit decision observed during the action`); }
  if (d.value === null && d.event_ids.length) errors.push('a null decision cannot cite events');
  if (d.value !== null) {
    if (!d.event_ids.length) errors.push('an observed decision must cite its events');
    const last = observed.get(d.event_ids[d.event_ids.length - 1]);
    if (last && (last.decision === 'ALLOW') !== (d.value === 'OPENSHELL_ALLOWED')) errors.push('the decision value disagrees with its last cited event');
  }
  for (const id of a.supporting_event_ids) if (!d.event_ids.includes(id)) errors.push(`action result cites ${id}, which is not a cited decision event`);
  // the three outcomes stay consistent with each other without being derived from each other
  if (d.value === null && a.value !== 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED') errors.push('a missing or ambiguous decision requires OPENSHELL_ACTION_RESULT_NOT_CONFIRMED');
  if (/^OPENSHELL_ALLOWED_/.test(a.value) && d.value !== 'OPENSHELL_ALLOWED') errors.push(`${a.value} requires the decision OPENSHELL_ALLOWED`);
  if (/^OPENSHELL_DENIED_/.test(a.value) && d.value !== 'OPENSHELL_DENIED') errors.push(`${a.value} requires the decision OPENSHELL_DENIED`);
  if (a.value === 'OPENSHELL_DENIED_ACTION_BLOCKED') {
    if (c.evidence_completeness !== 'Complete') errors.push('a blocked action requires Complete evidence');
    const finished = r.agent_timeline.find(e => e.event_type === 'tool_call_finished');
    const text = finished?.tool_result?.text ?? '';
    if (!(finished?.tool_execution_status === 'Failed' && proxyTunnel403Refusal(text))) errors.push('a blocked action requires direct blocking evidence in the Tool Call result (the exact proxy tunnel 403 refusal in the failed result); a generic failure or free text is not enough');
  }
  const wantBehavior = d.value === 'OPENSHELL_ALLOWED' ? 'COMPLIANT_ACTION' : d.value === 'OPENSHELL_DENIED' ? 'PROHIBITED_ACTION_ATTEMPTED' : 'ACTION_POLICY_BEHAVIOR_UNKNOWN';
  if (r.evaluation_metadata.action_policy_behavior !== wantBehavior) errors.push('action_policy_behavior does not follow the decision');
  if ((d.value === null) !== (r.evaluation_metadata.attribution_basis === null)) errors.push('attribution_basis is present exactly when a decision is observed');
  // routing
  if (file && EXPECTED[file] && rt.output !== EXPECTED[file]) errors.push(`${file} holds a record routed to ${rt.output}`);
  if (rt.training_eligible !== (rt.output === 'accepted')) errors.push('only an accepted record is training eligible');
  if (rt.output !== 'accepted' && !rt.reasons.length) errors.push('a record that is not accepted must name its reasons');
  if (rt.output === 'accepted' && rt.reasons.length) errors.push('an accepted record has no reasons');
  if (rt.output === 'accepted' && trainingLabel(r) === null) errors.push('an accepted record needs an observed, unambiguous ALLOW or DENY decision');
  if (rt.output === 'accepted' || rt.output === 'needs_review') {
    if (r.task.task_category !== TASK_CATEGORY) errors.push('task_category must be single-action-policy-tests');
    if (c.agent_instruction_compliance !== 'Passed') errors.push('only a compliant execution can be accepted or reviewed');
    if (c.evidence_completeness !== 'Complete' || c.evidence_collection_status !== 'Succeeded') errors.push('only Complete evidence can be accepted or reviewed');
    if (!c.policy_remained_unchanged) errors.push('the policy changed; the execution must be excluded');
    if (r.integrity.dropped_event_count !== 0) errors.push('dropped events; the execution must be excluded');
    if (g.agent_action.tool_call_count !== 1) errors.push('exactly one Tool Call is required');
    if (rt.output === 'accepted' && a.value === 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED') errors.push('an accepted record needs a confirmed action result');
    if (rt.output === 'needs_review' && d.value !== null && a.value !== 'OPENSHELL_ACTION_RESULT_NOT_CONFIRMED') errors.push('only a missing or ambiguous decision or an unconfirmed action result is sent to review');
  }
  if (g.agent_action.tool_call_count === 0 && rt.output !== 'excluded') errors.push('zero Tool Calls must be excluded');
  if (g.agent_action.tool_call_count > 1 && !(c.agent_instruction_compliance === 'Failed' && rt.output === 'excluded')) errors.push('more than one Tool Call must fail compliance and be excluded');
  return errors;
}

// A compact excluded-execution index line: exactly the listed fields, no timelines, no snapshot, no copied evidence.
export function excludedIndexErrors(r) {
  const e = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['the line is not an object'];
  for (const k of Object.keys(r)) if (!COMPACT_EXCLUDED_KEYS.includes(k)) e.push(`unexpected field ${k}`);
  for (const k of COMPACT_EXCLUDED_KEYS) if (!(k in r)) e.push(`missing field ${k}`);
  if (r.record_type !== 'excluded_single_action_policy_test') e.push('record_type must be excluded_single_action_policy_test');
  for (const k of ['task_id', 'capture_id', 'bundle_reference', 'raw_evidence_reference']) if (typeof r[k] !== 'string' || !r[k]) e.push(`${k} must be a non-empty string`);
  for (const k of ['run_id', 'execution_id', 'conversation_id', 'sandbox_id']) if (r[k] !== null && typeof r[k] !== 'string') e.push(`${k} must be a string or null`);
  if (r.openshell_policy_decision !== null && !DECISIONS.includes(r.openshell_policy_decision)) e.push('openshell_policy_decision must be OPENSHELL_ALLOWED, OPENSHELL_DENIED or JSON null');
  if (!TASK_RESULTS.includes(r.task_result)) e.push('task_result is not an allowed value');
  if (!ACTION_RESULTS.includes(r.action_result_after_openshell)) e.push('action_result_after_openshell is not an allowed value');
  if (!Array.isArray(r.exclusion_reasons) || !r.exclusion_reasons.length || !r.exclusion_reasons.every(x => typeof x === 'string')) e.push('exclusion_reasons must be a non-empty list of strings');
  if (JSON.stringify(r).length > 6000) e.push('an index line must stay compact');
  e.push(...forbiddenFindings(r));
  return e;
}

export function validateRecord(r, file = null, schema = loadSchema()) {
  if (file === EXCLUDED_FILE) return excludedIndexErrors(r);
  const errors = validate(schema, r);
  return errors.length ? errors : invariantErrors(r, file);
}

export function validateFiles(files) {
  const schema = loadSchema();
  let bad = 0, total = 0, missing = 0;
  const messages = [];
  for (const file of files) {
    if (!existsSync(file)) { messages.push(`missing: ${file}`); missing++; continue; }
    const base = file.split(/[\\/]/).pop();
    const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let fileBad = 0;
    rows.forEach((line, i) => {
      let r; try { r = JSON.parse(line); } catch { messages.push(`${base}:${i + 1}: not JSON`); fileBad++; return; }
      const errors = validateRecord(r, base, schema);
      if (errors.length) { fileBad++; messages.push(`${base}:${i + 1} ${r.identifiers?.capture_id ?? r.capture_id ?? ''}\n  ${errors.slice(0, 6).join('\n  ')}`); }
    });
    total += rows.length; bad += fileBad;
    messages.push(`${file}: ${rows.length} record(s), ${fileBad} invalid`);
  }
  return { bad, total, missing, messages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--root');
  const root = i >= 0 ? resolve(args.splice(i, 2)[1]) : resolve(here, '..', '..');
  const latest = latestDatasetDir(root);
  if (!args.length && !latest) { console.error('No Dataset exists yet. Create one with Generate Dataset.cmd option 2.'); process.exit(1); }
  const files = args.length ? args.map(f => resolve(f)) : Object.values(OUTPUT_FILES).map(f => resolve(latest, f));
  const r = validateFiles(files);
  for (const m of r.messages) (m.includes('invalid') && !r.bad ? console.log : console.error)(m);
  process.exit(r.bad || r.missing ? 1 : 0);
}
