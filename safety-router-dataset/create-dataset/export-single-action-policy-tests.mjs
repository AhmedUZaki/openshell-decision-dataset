// Creates the Safety Router Dataset of Single-Action Policy Tests from the saved Bundles, in ONE step: build, validate, verify independently, confirm the
// build is deterministic, and only then save it as a NEW folder whose name carries the UTC time of its creation:
//   .local/safety-router/datasets/safety-router-dataset-<YYYYMMDDTHHMMSSmmmZ>/
//     accepted-execution-records.jsonl   complete, verified executions with an observed ALLOW or DENY decision (the authoritative accepted Dataset)
//     needs-review-records.jsonl         complete executions whose decision or action result cannot be established
//     excluded-execution-index.jsonl     compact index of every other execution, with its reasons
//     manifest.json                      statistics, plus the Dataset's own identity (id, folder name, created time)
// Bundles are only read. Nothing is written until everything has passed; the folder is built under a temporary name and renamed into place, and an existing
// Dataset folder is never overwritten or merged. The creation time exists only in the folder name and in the manifest's identity fields: not in any record,
// label, record hash or the semantic dataset_content_hash.
//   node safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs [--check]     --check does everything except saving
//import { writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDataset } from './build-dataset.mjs';
import { validateFiles } from './validate-single-action-policy-tests.mjs';
import { verifyOutput } from './verify-single-action-policy-tests.mjs';
import { datasetIdentity, datasetsDir, insideDatasets } from './dataset-location.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = resolve(here, '..', '..');
export { buildDataset, MANIFEST_SCHEMA, DATASET_LIMITATION } from './build-dataset.mjs';

// Builds twice (the two builds must be identical), validates and independently verifies the result in a temporary folder inside datasets/, then renames it to
// its timestamped name. `clock` is read exactly once. A same-millisecond collision fails clearly; nothing is overwritten.
export function exportDataset(root = defaultRoot, { check = false, clock = () => new Date(), build = buildDataset, validate = validateFiles, verify = verifyOutput } = {}) {
  const data = build(root), again = build(root);
  for (const n of Object.keys(data.files)) if (data.files[n] !== again.files[n]) throw Error(`The build is not deterministic: ${n} differs between two builds. No Dataset was created.`);
  if (data.manifestText !== again.manifestText) throw Error('The build is not deterministic: manifest.json differs between two builds. No Dataset was created.');
  const identity = datasetIdentity(clock());
  const manifestText = JSON.stringify({ ...data.manifest, ...identity }, null, 2) + '\n';
  const base = datasetsDir(root), tmp = resolve(base, `.tmp-${process.pid}`), target = resolve(base, identity.dataset_snapshot_directory);
  if (!insideDatasets(root, target) || !insideDatasets(root, tmp)) throw Error(`No Dataset was created: ${target} is not inside ${base}.`);
  mkdirSync(base, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  try {
    for (const [n, text] of Object.entries(data.files)) writeFileSync(resolve(tmp, n), text);
    writeFileSync(resolve(tmp, 'manifest.json'), manifestText);
    const v = validate(Object.keys(data.files).map(n => resolve(tmp, n)));
    if (v.bad || v.missing) throw Error(`The new Dataset does not validate; none was created.\n${v.messages.filter(m => !m.includes(': 0 ')).join('\n')}`);
    const ar = data.manifest.active_records;
    if (ar.source_bundle_count !== ar.accepted_count + ar.needs_review_count + ar.excluded_count) throw Error('An execution was dropped: the three outputs do not add up to the Bundle count.');
    const verified = verify(root, tmp);
    if (!verified.ok) throw Error(`Independent verification failed; none was created.\n${verified.failures.slice(0, 10).join('\n')}`);
    if (!check) {
      if (existsSync(target)) throw Error(`No Dataset was created: ${target} already exists (the same millisecond). Nothing was overwritten; run it again.`);
      renameSync(tmp, target);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { ...data, manifest: JSON.parse(manifestText), manifestText, dir: check ? null : target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--check')) { console.error('Usage: node safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs [--check]'); process.exit(2); }
  try {
    const { manifest, dir } = exportDataset(defaultRoot, { check: args.includes('--check') });
    const a = manifest.active_records, d = manifest.openshell_policy_decisions;
    console.log(`${a.source_bundle_count} active Bundle(s): ${a.accepted_count} accepted, ${a.needs_review_count} need review, ${a.excluded_count} excluded.`);
    console.log(`OpenShell decisions: ALLOWED ${d.OPENSHELL_ALLOWED}, DENIED ${d.OPENSHELL_DENIED}, missing ${d.missing}, ambiguous ${d.ambiguous}; training-eligible labels ${a.training_eligible_count}`);
    console.log('Built, validated, independently verified and deterministic.');
    console.log(args.includes('--check') ? 'Check only: nothing was saved.' : `${manifest.dataset_snapshot_id}\nSaved: ${dir}\naccepted-execution-records.jsonl is the authoritative accepted execution-record Dataset (not yet a fine-tuning format).`);
  } catch (e) { console.error(e.message); process.exit(1); }
}