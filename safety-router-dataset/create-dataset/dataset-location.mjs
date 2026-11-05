// Where Safety Router Datasets live and how they are named. There is no un-timestamped copy: every Dataset the project creates is born in its own folder
//   .local/safety-router/datasets/safety-router-dataset-<YYYYMMDDTHHMMSSmmmZ>/
// (UTC, Windows-safe: no colon, space or slash), so the date of every Dataset is part of its name from the start. Folders are never overwritten or merged.
// The identity (id, directory, created time) is operational metadata of the Dataset's manifest only; it is in no record, label or content hash.
import { existsSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

export const DATASET_PREFIX = 'safety-router-dataset-';
export const DATASET_FILES = ['accepted-execution-records.jsonl', 'needs-review-records.jsonl', 'excluded-execution-index.jsonl', 'manifest.json'];
export const datasetsDir = root => resolve(root, '.local/safety-router/datasets');
const NAME = /^safety-router-dataset-\d{8}T\d{9}Z$/;

// YYYYMMDDTHHMMSSmmmZ
export function datasetStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw Error('the clock did not return a valid Date');
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}
// The three identity values always describe the same instant.
export function datasetIdentity(date) {
  const stamp = datasetStamp(date);
  return { dataset_snapshot_id: `Safety Router Dataset ${stamp}`, dataset_snapshot_directory: `${DATASET_PREFIX}${stamp}`, dataset_snapshot_created_utc: date.toISOString() };
}
export const IDENTITY_KEYS = ['dataset_snapshot_id', 'dataset_snapshot_directory', 'dataset_snapshot_created_utc'];
// True only for an absolute path strictly inside .local/safety-router/datasets/.
export function insideDatasets(root, p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const rel = relative(datasetsDir(root), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
// Every Dataset folder, oldest first (the names sort chronologically).
export function listDatasets(root) {
  const dir = datasetsDir(root);
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME.test(e.name)).map(e => e.name).sort() : [];
}
// The newest Dataset folder, or null when none was created yet.
export function latestDatasetDir(root) {
  const all = listDatasets(root);
  return all.length ? resolve(datasetsDir(root), all[all.length - 1]) : null;
}
