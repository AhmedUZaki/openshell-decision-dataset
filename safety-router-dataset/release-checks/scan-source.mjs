// Scans every file Git would stage (everything .gitignore does not exclude) for secrets and machine-specific paths, and lists them.
//   node safety-router-dataset/release-checks/scan-source.mjs            scan, exit 1 on any finding
//   node safety-router-dataset/release-checks/scan-source.mjs --list     also print every candidate file
// Reads only. Run it before the first commit and before publishing.
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateFiles, scanText, privateNames, formatFinding, MAX_SCAN_BYTES } from './scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function scanSource(base = root) {
  const files = candidateFiles(base);
  const names = privateNames(base);
  const findings = [], skipped = [];
  for (const rel of files) {
    const full = resolve(base, rel);
    if (statSync(full).size > MAX_SCAN_BYTES) { skipped.push(rel); continue; }
    const buf = readFileSync(full);
    if (buf.includes(0)) { skipped.push(rel); continue; }
    findings.push(...scanText(buf.toString('utf8'), { names, file: rel, allowSynthetic: true }));
  }
  return { files, findings, skipped };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = scanSource();
  if (process.argv.includes('--list')) for (const f of r.files) console.log(f);
  for (const f of r.findings) console.log('FINDING ' + formatFinding(f));
  for (const s of r.skipped) console.log('SKIPPED (binary or over 8 MB) ' + s);
  console.log(`${r.files.length} file(s) Git would include, ${r.findings.length} finding(s)`);
  process.exit(r.findings.length ? 1 : 0);
}
