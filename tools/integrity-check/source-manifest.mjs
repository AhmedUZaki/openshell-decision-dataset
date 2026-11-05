// Writes and verifies setup/checksums.json, the list of protected source files and their SHA-256.
//   node tools/integrity-check/source-manifest.mjs --check   verify the tree against the manifest (exit 1 on any difference)
//   node tools/integrity-check/source-manifest.mjs --write   regenerate the manifest from the tree (after an intended source change)
// The same rules are applied by setup/Verify-Checksums.ps1, which Verify Installation.cmd runs. Generation is deterministic:
// sorted forward-slash paths, SHA-256 of the exact bytes, no timestamps, LF line endings.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED_RULES, MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, buildEntries, listProtectedFiles, fileSha256, defaultRoot } from '../events-panel/source-identity.mjs';

export function buildManifest(root = defaultRoot) {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, algorithm: 'SHA256', protected: PROTECTED_RULES, files: buildEntries(root) };
}
export const manifestText = manifest => JSON.stringify(manifest, null, 2) + '\n';

export function writeManifest(root = defaultRoot) {
  const manifest = buildManifest(root);
  const file = resolve(root, MANIFEST_FILE);
  const temp = file + '.tmp';
  writeFileSync(temp, manifestText(manifest));
  renameSync(temp, file);
  return manifest;
}

// Compares the tree with the manifest. Three different problems, reported separately:
//   missing       listed in the manifest, not on disk
//   modified      on disk, different SHA-256
//   unregistered  a protected source file that the manifest does not list
export function verifyManifest(root = defaultRoot) {
  const file = resolve(root, MANIFEST_FILE);
  const result = { ok: false, error: null, verified: 0, missing: [], modified: [], unregistered: [] };
  if (!existsSync(file)) return { ...result, error: `${MANIFEST_FILE} is missing` };
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ...result, error: `${MANIFEST_FILE} is not valid JSON: ${e.message}` }; }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.algorithm !== 'SHA256' || !Array.isArray(manifest.files)) return { ...result, error: `${MANIFEST_FILE} is not a schema ${MANIFEST_SCHEMA_VERSION} SHA256 manifest; run: node tools/integrity-check/source-manifest.mjs --write` };
  const listed = new Map();
  for (const entry of manifest.files) listed.set(String(entry.path).replaceAll('\\', '/'), entry.sha256);
  for (const [path, sha] of listed) {
    const full = resolve(root, path);
    if (!existsSync(full)) result.missing.push(path);
    else if (fileSha256(full) !== sha) result.modified.push(path);
    else result.verified++;
  }
  for (const path of listProtectedFiles(root, manifest.protected ?? PROTECTED_RULES)) if (!listed.has(path)) result.unregistered.push(path);
  result.ok = !result.missing.length && !result.modified.length && !result.unregistered.length;
  return result;
}

export function formatVerification(r) {
  if (r.error) return [`FAIL  ${r.error}`];
  const lines = [];
  for (const p of r.missing) lines.push(`MISSING       ${p}`);
  for (const p of r.modified) lines.push(`MODIFIED      ${p}`);
  for (const p of r.unregistered) lines.push(`UNREGISTERED  ${p}`);
  lines.push(r.ok ? `PASS  ${r.verified} protected source file(s) match setup/checksums.json` : `FAIL  ${r.missing.length} missing, ${r.modified.length} modified, ${r.unregistered.length} unregistered (${r.verified} verified)`);
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2];
  if (mode === '--write') { const m = writeManifest(); console.log(`${MANIFEST_FILE}: ${m.files.length} protected source file(s) registered`); }
  else if (mode === '--check') { const r = verifyManifest(); for (const l of formatVerification(r)) console.log(l); process.exit(r.ok ? 0 : 1); }
  else { console.error('Usage: node tools/integrity-check/source-manifest.mjs --check | --write'); process.exit(2); }
}
