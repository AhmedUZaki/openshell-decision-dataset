// The evidence layers for OpenShell data, kept apart from the training schema:
//   .local/evidence/raw/<run-id>/<execution-id>/        everything OpenShell reported for one sandbox, exactly as received (private)
//   .local/evidence/sanitized/<run-id>/<execution-id>/  the same data with credentials redacted, derived from the raw layer
// Nothing is dropped from the raw layer: not background traffic, not events outside a tool call, not events without a decision, not events
// before the selected policy revision. "Excluded from training" never means "deleted from evidence". A raw folder is written once (files are
// created with the exclusive flag, then made read-only) and never overwritten; sanitizing writes elsewhere.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const EVIDENCE_SCHEMA = 1;
export const SANITIZER_VERSION = 'sanitizer-1';
export const LOG_LIMIT = 100000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const sha = data => createHash('sha256').update(data).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
// Line endings are normalized so a checkout with CRLF and one with LF give the same sanitizer hash.
export const sanitizerSourceHash = () => sha(readFileSync(resolve(here, 'evidence.mjs'), 'utf8').replace(/\r\n/g, '\n'));

// ---- paths: ids are validated and the result must stay inside .local/evidence/<layer> ---------------------------------------
export function evidenceDir(root, layer, runId, executionId) {
  if (!['raw', 'sanitized'].includes(layer)) throw Error('Unknown evidence layer.');
  for (const [name, v] of [['run id', runId], ['execution id', executionId]]) if (!ID.test(String(v)) || String(v).includes('..')) throw Error(`The ${name} is not valid.`);
  const base = resolve(root, '.local/evidence', layer);
  const dir = resolve(base, runId, executionId);
  if (!dir.startsWith(base + sep)) throw Error('The evidence path leaves the evidence folder.');
  return dir;
}

// ---- reading lines -------------------------------------------------------------------------------------------------------------
const CATEGORY = { NET: 'network', HTTP: 'http', DNS: 'dns', PROC: 'process', PROCESS: 'process', CONFIG: 'config', POLICY: 'policy', FS: 'filesystem', SSH: 'ssh', SANDBOX: 'lifecycle', LIFECYCLE: 'lifecycle', GATEWAY: 'lifecycle' };
// One record per log line, whatever the line is. The decision is set only when OpenShell wrote an explicit ALLOWED or DENIED verdict
// right after the severity of an OCSF event; nothing else ever gets one.
export function classifyLine(line, n) {
  const m = /^\[(\d+(?:\.\d+)?)\]\s+\[([^\]]*)\]\s+\[([^\]]*)\]\s+\[([^\]]*)\]\s?(.*)$/.exec(line);
  const rec = { line: n, time: null, source: null, level: null, target: null, category: 'log', type: null, decision: null };
  if (!m) return rec;
  rec.time = Number.isFinite(Number(m[1])) ? new Date(Number(m[1]) * 1000).toISOString() : null;
  [rec.source, rec.level, rec.target] = [m[2].trim(), m[3].trim(), m[4].trim()];
  const rest = m[5];
  if (rec.target === 'ocsf') {
    const t = /^([A-Z_]+):([A-Z_]+)\s+\[[^\]]*\]\s*(.*)$/.exec(rest);
    if (t) {
      rec.type = `${t[1]}:${t[2]}`;
      rec.category = CATEGORY[t[1]] ?? 'other';
      const verdict = /^(ALLOWED|DENIED)\b/.exec(t[3]);
      rec.decision = verdict ? (verdict[1] === 'ALLOWED' ? 'ALLOW' : 'DENY') : null;
    } else rec.category = 'other';
  } else if (/\bpolic(?:y|ies)\b.*\b(?:load|loaded|reload|revision|version|applied|update)/i.test(rest)) rec.category = 'policy';
  else if (/\b(?:sandbox|container|gateway)\b.*\b(?:start|started|stop|stopped|ready|create|created|exit)/i.test(rest)) rec.category = 'lifecycle';
  return rec;
}
export function parseRaw(text) {
  const out = [], lines = text.split(/\r?\n/);
  let blank = 0;
  lines.forEach((line, i) => { if (line === '') { blank++; return; } out.push({ ...classifyLine(line, i + 1), raw_line: line }); });
  return { records: out, lines: lines.length, blank_lines: blank };
}
export function summarizeEvents(records) {
  const by = {};
  for (const r of records) by[r.category] = (by[r.category] || 0) + 1;
  const allow = records.filter(r => r.decision === 'ALLOW').length, deny = records.filter(r => r.decision === 'DENY').length;
  return { total: records.length, by_category: Object.fromEntries(Object.keys(by).sort().map(k => [k, by[k]])), explicit_allow: allow, explicit_deny: deny, without_decision: records.length - allow - deny };
}

// ---- sanitizing ------------------------------------------------------------------------------------------------------------------
// The line keeps its structure (event type, host, port, path, policy, reason, verdict and the names of query parameters). What is removed:
// the values of sensitive query parameters and key=value credentials, URL fragments and user:password parts, bearer tokens, authorization
// and cookie headers, and long opaque identifiers.
const SENSITIVE = '(?:access_token|id_token|refresh_token|token|api[_-]?key|apikey|key|password|passwd|pwd|secret|client_secret|sig|signature|auth|authorization|session|sessionid|sid|code|credential|credentials)';
export function sanitizeLine(line) {
  return String(line)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)(\s*[:=]\s*)[^\r\n\]]*/gi, '$1$2[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@\]]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s#\]]*)#[^\s\]]*/gi, '$1#[redacted]')
    .replace(new RegExp(`([?&;]|\\b)(${SENSITIVE})=([^&\\s\\]"',;]*)`, 'gi'), (all, lead, key, value) => value === '[redacted]' ? all : `${lead}${key}=[redacted]`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{40,})\b/g, '[identifier redacted]');
}
// ---- writing ---------------------------------------------------------------------------------------------------------------------
const lock = file => { try { chmodSync(file, 0o444); } catch { /* best effort: the exclusive create already prevents an overwrite by this code */ } };
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
function createFiles(dir, files) {
  if (existsSync(dir) && readdirSync(dir).length) throw Error(`${dir} already holds evidence; it is never overwritten.`);
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [name, content] of Object.entries(files)) {
    const file = resolve(dir, name);
    writeFileSync(file, content, { flag: 'wx' });
    out[name] = { sha256: sha(content), bytes: Buffer.byteLength(content) };
  }
  return out;
}
function finalize(dir, manifest) {
  const text = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(resolve(dir, 'manifest.json'), text, { flag: 'wx' });
  for (const n of readdirSync(dir)) lock(resolve(dir, n));
  return sha(text);
}

// Saves everything OpenShell reported for one sandbox. `text` is the log exactly as received; `capture` describes the capture itself.
export function writeRawEvidence({ root, runId, executionId, text, capture, now = () => new Date() }) {
  const dir = evidenceDir(root, 'raw', runId, executionId);
  const parsed = parseRaw(text);
  const counts = summarizeEvents(parsed.records);
  // `openshell logs -n LOG_LIMIT` returns at most LOG_LIMIT lines. A capture that is full may have lost older events, so it is not complete evidence.
  const returnedLines = parsed.lines - (text.endsWith('\n') ? 1 : 0);
  const limitReached = returnedLines >= LOG_LIMIT;
  const evidenceCompleteness = limitReached ? 'Truncated' : 'Complete';
  const captureDoc = {
    schema_version: EVIDENCE_SCHEMA, run_id: runId, execution_id: executionId, ...capture,
    source: 'openshell logs <sandbox> --source sandbox', log_limit: LOG_LIMIT, line_count: parsed.lines, blank_lines: parsed.blank_lines,
    returned_lines: returnedLines, log_limit_reached: limitReached, evidence_completeness: evidenceCompleteness, counts,
  };
  const files = createFiles(dir, { 'openshell-sandbox.log': text, 'openshell-events.raw.jsonl': jsonl(parsed.records), 'capture.json': JSON.stringify(captureDoc, null, 2) + '\n' });
  const manifest = { schema_version: EVIDENCE_SCHEMA, layer: 'raw', run_id: runId, execution_id: executionId, files, counts, log_limit_reached: limitReached, evidence_completeness: evidenceCompleteness, finalized_at: now().toISOString(),
    note: 'Private. Written once and never overwritten. May contain credentials: do not publish.' };
  return { dir, counts, manifest, manifest_sha256: finalize(dir, manifest), records: parsed.records.length, evidence_completeness: evidenceCompleteness, log_limit_reached: limitReached };
}

// Derives the sanitized layer from the raw layer, after checking the raw layer is intact. It writes only under evidence/sanitized.
export function writeSanitizedEvidence({ root, runId, executionId, now = () => new Date() }) {
  const check = verifyRaw({ root, runId, executionId });
  if (!check.ok) throw Error(`The raw evidence is not intact: ${check.failures.join('; ')}`);
  const rawDir = evidenceDir(root, 'raw', runId, executionId);
  const text = readFileSync(resolve(rawDir, 'openshell-sandbox.log'), 'utf8');
  const records = readFileSync(resolve(rawDir, 'openshell-events.raw.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const log = text.split(/\r?\n/).map(sanitizeLine).join('\n');
  const events = records.map(({ raw_line, ...r }) => ({ ...r, sanitized_line: sanitizeLine(raw_line), raw_line_sha256: sha(raw_line) }));
  const dir = evidenceDir(root, 'sanitized', runId, executionId);
  const files = createFiles(dir, { 'openshell-sandbox.sanitized.log': log, 'openshell-events.sanitized.jsonl': jsonl(events) });
  const manifest = { schema_version: EVIDENCE_SCHEMA, layer: 'sanitized', run_id: runId, execution_id: executionId, sanitizer_version: SANITIZER_VERSION, sanitizer_source_sha256: sanitizerSourceHash(),
    raw_manifest_sha256: check.manifest_sha256, raw_files: check.manifest.files, files, counts: check.manifest.counts, finalized_at: now().toISOString(),
    note: 'Derived from the raw layer; the raw layer is never replaced by it.' };
  return { dir, manifest, manifest_sha256: finalize(dir, manifest), log };
}

// ---- verifying -------------------------------------------------------------------------------------------------------------------
function readManifest(dir) {
  const file = resolve(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return { manifest: JSON.parse(text), sha: sha(text) };
}
export function verifyRaw({ root, runId, executionId }) {
  const failures = [];
  const dir = evidenceDir(root, 'raw', runId, executionId);
  const m = existsSync(dir) ? readManifest(dir) : null;
  if (!m) return { ok: false, failures: ['the raw evidence manifest is missing'] };
  for (const [name, h] of Object.entries(m.manifest.files)) {
    const file = resolve(dir, name);
    if (!existsSync(file)) { failures.push(`${name} is missing`); continue; }
    const data = readFileSync(file);
    if (sha(data) !== h.sha256 || data.length !== h.bytes) failures.push(`${name} does not match its recorded hash`);
  }
  if (!failures.length) {
    const parsed = parseRaw(readFileSync(resolve(dir, 'openshell-sandbox.log'), 'utf8'));
    const stored = readFileSync(resolve(dir, 'openshell-events.raw.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    if (stored !== parsed.records.length) failures.push(`the structured events (${stored}) do not cover every log line (${parsed.records.length}): events were dropped`);
    if (JSON.stringify(summarizeEvents(parsed.records)) !== JSON.stringify(m.manifest.counts)) failures.push('the recorded counts do not match the log');
  }
  return { ok: failures.length === 0, failures, manifest: m.manifest, manifest_sha256: m.sha, dir };
}
export function verifySanitized({ root, runId, executionId }) {
  const failures = [];
  const raw = verifyRaw({ root, runId, executionId });
  if (!raw.ok) return { ok: false, failures: raw.failures.map(f => `raw: ${f}`) };
  const dir = evidenceDir(root, 'sanitized', runId, executionId);
  const m = existsSync(dir) ? readManifest(dir) : null;
  if (!m) return { ok: false, failures: ['the sanitized evidence manifest is missing'] };
  if (m.manifest.raw_manifest_sha256 !== raw.manifest_sha256) failures.push('the sanitized layer was not derived from this raw manifest');
  for (const [name, h] of Object.entries(m.manifest.files)) {
    const file = resolve(dir, name);
    if (!existsSync(file) || sha(readFileSync(file)) !== h.sha256) failures.push(`${name} is missing or does not match its recorded hash`);
  }
  if (!failures.length) {
    const rebuilt = readFileSync(resolve(raw.dir, 'openshell-sandbox.log'), 'utf8').split(/\r?\n/).map(sanitizeLine).join('\n');
    if (rebuilt !== readFileSync(resolve(dir, 'openshell-sandbox.sanitized.log'), 'utf8')) failures.push('the sanitized log is not what sanitizing the raw log gives');
  }
  if (m.manifest.sanitizer_source_sha256 !== sanitizerSourceHash()) failures.push('the sanitizer code changed since this evidence was sanitized');
  return { ok: failures.length === 0, failures, manifest: m.manifest, manifest_sha256: m.sha, dir };
}

// Bytes used by a folder (for disk reports).
export function folderBytes(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? folderBytes(resolve(dir, e.name)) : statSync(resolve(dir, e.name)).size), 0);
}
