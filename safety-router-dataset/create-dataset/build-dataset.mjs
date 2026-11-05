// Builds, in memory, everything a Dataset contains (the three JSONL files and the manifest without its identity) from the saved Bundles. Pure and deterministic:
// the same Bundles and source always give the same bytes. It is separate from the exporter so that the independent verifier can rebuild it for its
// determinism check without importing the exporter (which imports the verifier).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActiveCaptures, buildOutcomeRecord, capturesDir, compactExcluded, DECISIONS, TASK_RESULTS, ACTION_RESULTS } from '../../tools/events-panel/single-action-record.mjs';
import { canonicalJson, sha256 } from '../../tools/events-panel/provenance.mjs';
import { projectIdentity } from '../../tools/events-panel/source-identity.mjs';
import { privateNames } from '../release-checks/scan.mjs';
import { OUTPUT_FILES, trainingLabel } from './validate-single-action-policy-tests.mjs';

export { OUTPUT_FILES };
const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = resolve(here, '..', '..');
export const MANIFEST_SCHEMA = 'single-action-policy-tests-manifest-2';
export const DATASET_LIMITATION = 'The current weather pilot executions validate only the Data Collection Pipeline. They are not sufficient for training, benchmarking, or evaluating a Safety Router.';

const tally = (keys, items, key) => { const out = Object.fromEntries(keys.map(k => [k, 0])); for (const i of items) { const k = key(i); if (k in out) out[k]++; } return out; };
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// Everything the export will write, in memory. Deterministic: the same active Bundles and source always give the same bytes. Only Bundles whose saved
// task metadata declares a Single-Action Policy Test are read; any other Bundle is outside the protocol and appears nowhere in the output.
export function buildDataset(root = defaultRoot) {
  const names = privateNames(root);
  const ids = listActiveCaptures(root);
  const built = ids.map(id => buildOutcomeRecord(root, id, { names }));
  const key = ({ record: r }) => [r.identifiers.run_id ?? '', r.identifiers.execution_id ?? '', r.identifiers.capture_id].join('\u0000');
  built.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const by = cat => built.filter(b => b.category === cat).map(b => b.record);
  const accepted = by('training'), review = by('review'), excluded = by('excluded');
  const files = { [OUTPUT_FILES.accepted]: jsonl(accepted), [OUTPUT_FILES.review]: jsonl(review), [OUTPUT_FILES.excluded]: jsonl(excluded.map(compactExcluded)) };
  const all = built.map(b => b.record);

  const environments = new Map();
  for (const id of ids) {
    const e = readJson(resolve(capturesDir(root), id, 'environment.json'));
    if (!e) continue;
    const entry = { model: e.model?.configured ?? null, model_digest: e.model?.ollama_digest ?? null, versions: e.versions ?? null, runtime_image_id: e.reproducibility?.runtime_image_id ?? null };
    environments.set(sha256(canonicalJson(entry)), entry);
  }
  const reasons = {};
  for (const r of excluded) for (const x of r.routing.reasons) { const k = x.replace(/\d+/g, 'N'); reasons[k] = (reasons[k] ?? 0) + 1; }
  const count = (items, k) => { const out = {}; for (const i of items) { const v = k(i) ?? 'unknown'; out[v] = (out[v] ?? 0) + 1; } return Object.fromEntries(Object.keys(out).sort().map(x => [x, out[x]])); };
  const dec = r => r.outcomes.openshell_policy_decision;
  const labels = accepted.map(trainingLabel).filter(Boolean);
  const fileInfo = Object.fromEntries(Object.entries(files).map(([n, text]) => [n, { records: text ? text.trim().split('\n').length : 0, bytes: Buffer.byteLength(text), sha256: sha256(text) }]));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    record_type: 'single_action_policy_test_record',
    active_records: {
      source_bundle_count: built.length, accepted_count: accepted.length, needs_review_count: review.length, excluded_count: excluded.length,
      training_eligible_count: labels.length, not_training_eligible_count: built.length - labels.length,
    },
    openshell_policy_decisions: {
      OPENSHELL_ALLOWED: all.filter(r => dec(r).value === 'OPENSHELL_ALLOWED').length, OPENSHELL_DENIED: all.filter(r => dec(r).value === 'OPENSHELL_DENIED').length,
      missing: all.filter(r => dec(r).evidence_status === 'OPENSHELL_DECISION_MISSING').length, ambiguous: all.filter(r => dec(r).evidence_status === 'OPENSHELL_DECISION_AMBIGUOUS').length,
    },
    task_results: tally(TASK_RESULTS, all, r => r.outcomes.task_result.value),
    action_results_after_openshell: tally(ACTION_RESULTS, all, r => r.outcomes.action_result_after_openshell.value),
    training_eligible_binary_labels: tally(DECISIONS, labels, l => l),
    active_policy_profiles: count(all, r => r.applied_policy.policy_profile),
    active_task_ids: [...new Set(all.map(r => r.task.task_id).filter(Boolean))].sort(),
    active_exclusion_reason_counts: Object.fromEntries(Object.keys(reasons).sort().map(k => [k, reasons[k]])),
    model_and_component_versions: [...environments.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, v]) => v),
    project_identity: projectIdentity(root),
    files: fileInfo,
    dataset_content_hash: sha256(canonicalJson(Object.fromEntries(Object.entries(fileInfo).map(([n, i]) => [n, i.sha256])))),
    dataset_limitation: `${DATASET_LIMITATION} This export holds ${accepted.length} accepted record(s) from ${built.length} source Bundle(s); ${review.length} need review and ${excluded.length} are excluded. It is not ready for training.`,
    note: 'Built only from saved Single-Action Policy Test Bundles. The OpenShell decision comes only from explicit OpenShell ALLOWED/DENIED events attributed to the single action; Task Result, Action Result After OpenShell, Agent behaviour and the decision evidence status are evaluation metadata, never a Router input or label. The export time is not stored anywhere: the output is a pure function of the Bundles, the schema and the source files. accepted-execution-records.jsonl is the authoritative accepted Dataset; it is not a model-specific fine-tuning format.',
  };
  return { files, manifest, manifestText: JSON.stringify(manifest, null, 2) + '\n', built };
}
