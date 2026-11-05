import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyLine, parseRaw, summarizeEvents, sanitizeLine, writeRawEvidence, writeSanitizedEvidence, verifyRaw, verifySanitized, evidenceDir, SANITIZER_VERSION } from '../tools/events-panel/evidence.mjs';
import { testTmp } from './tmp-dir.mjs';

const sha = d => createHash('sha256').update(d).digest('hex');
const LOG = [
  '[1793570000.000] [sandbox] [INFO ] [openshell_sandbox] sandbox starting',
  '[1793570000.100] [sandbox] [OCSF ] [ocsf] CONFIG:APPLYING [INFO] Applying Landlock filesystem sandbox [abi:v3 compat:best_effort ro:8 rw:2]',
  '[1793570000.200] [sandbox] [OCSF ] [ocsf] CONFIG:LOADED [INFO] policy version 3 loaded',
  '[1793570001.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(2232) -> pypi.org:443 [policy:pypi engine:opa]',
  '[1793570001.100] [sandbox] [OCSF ] [ocsf] HTTP:GET [INFO] ALLOWED GET https://pypi.org/simple/?token=abc123SECRET#frag [policy:pypi engine:l7]',
  '[1793570002.000] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(2300) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]',
  '[1793570002.500] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] example.com:443 connection was denied by the remote server',
  '[1793570003.000] [sandbox] [OCSF ] [ocsf] DNS:QUERY [INFO] resolved pypi.org',
  '[1793570003.100] [sandbox] [OCSF ] [ocsf] PROC:LAUNCH [INFO] /usr/bin/curl(2300) started',
  '[1793570003.200] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/local/bin/node(1) -> host.openshell.internal:11435 [policy:managed_inference engine:opa]',
  '[1793570004.000] [sandbox] [INFO ] [proxy] Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789 and Cookie: session=topsecret',
  '[1793570004.500] [sandbox] [INFO ] [proxy] fetching https://api.example.com/v1/items?api_key=SECRETKEY99&page=2',
  '',
  'a line that is not in the usual format at all',
].join('\n') + '\n';

function tmp() { const root = testTmp('evidence-'); return { root, done: () => rmSync(root, { recursive: true, force: true }) }; }
const meta = { started_at: '2026-11-02T10:00:00.000Z', ended_at: '2026-11-02T10:01:00.000Z', openshell_version: '0.0.116', sandbox_id: 's-1', conversation_id: 'conv-0000000001', capture_id: 'capture-' + 'a'.repeat(24) };

test('a line is classified by what it is, and only an explicit ALLOWED or DENIED verdict gives a decision', () => {
  const c = (i) => classifyLine(LOG.split('\n')[i], i + 1);
  assert.deepEqual([c(3).category, c(3).type, c(3).decision], ['network', 'NET:OPEN', 'ALLOW']);
  assert.deepEqual([c(4).category, c(4).decision], ['http', 'ALLOW']);
  assert.deepEqual([c(5).category, c(5).decision], ['network', 'DENY']);
  assert.deepEqual([c(6).category, c(6).decision], [ 'network', null], 'the word "denied" in the text is not a verdict');
  assert.deepEqual([c(1).category, c(2).category], ['config', 'config']);
  assert.deepEqual([c(7).category, c(8).category], ['dns', 'process']);
  assert.deepEqual([c(0).category, c(0).decision], ['lifecycle', null]);
  assert.deepEqual([classifyLine('not a log line', 1).category, classifyLine('not a log line', 1).time], ['log', null]);
  assert.equal(c(3).time, '2026-11-02T04:13:21.000Z'.replace('2026-11-02T04:13:21', new Date(1793570001 * 1000).toISOString().slice(0, 19)));
  for (const line of ['x', '[1.0] [a] [b] [ocsf] NET:OPEN [INFO] exit code 0', '[1.0] [a] [b] [ocsf] NET:OPEN [INFO] HTTP 200 OK', '[1.0] [a] [b] [ocsf] NET:OPEN [INFO] success']) assert.equal(classifyLine(line, 1).decision, null, line);
});

test('the raw layer keeps every line, including background, unlabelled and non-OCSF ones, and counts them', () => {
  const { root, done } = tmp();
  try {
    const r = writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: LOG, capture: meta, now: () => new Date('2026-11-02T10:02:00Z') });
    const nonBlank = LOG.split('\n').filter(l => l !== '');
    assert.equal(r.records, nonBlank.length, 'one structured record per non-empty line: nothing dropped');
    const events = readFileSync(join(r.dir, 'openshell-events.raw.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.deepEqual(events.map(e => e.raw_line), nonBlank, 'every original line, unredacted, in order');
    assert.equal(readFileSync(join(r.dir, 'openshell-sandbox.log'), 'utf8'), LOG, 'the original text exactly as received');
    assert.deepEqual([r.counts.total, r.counts.explicit_allow, r.counts.explicit_deny, r.counts.without_decision], [nonBlank.length, 3, 1, nonBlank.length - 4]);
    assert.ok(r.counts.by_category.config === 2 && r.counts.by_category.dns === 1 && r.counts.by_category.process === 1 && r.counts.by_category.network >= 4 && r.counts.by_category.log >= 3);
    assert.match(readFileSync(join(r.dir, 'openshell-sandbox.log'), 'utf8'), /sk-abcdefghijklmnopqrstuvwxyz0123456789/, 'the raw layer is not sanitized');
    const capture = JSON.parse(readFileSync(join(r.dir, 'capture.json'), 'utf8'));
    assert.deepEqual([capture.run_id, capture.execution_id, capture.openshell_version, capture.sandbox_id, capture.conversation_id, capture.started_at, capture.ended_at, capture.log_limit_reached, capture.blank_lines], ['run-1', 'run-1-e00001', '0.0.116', 's-1', 'conv-0000000001', meta.started_at, meta.ended_at, false, 2]);
    assert.deepEqual(readdirSync(r.dir).sort(), ['capture.json', 'manifest.json', 'openshell-events.raw.jsonl', 'openshell-sandbox.log']);
    const manifest = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8'));
    for (const [name, h] of Object.entries(manifest.files)) assert.equal(sha(readFileSync(join(r.dir, name))), h.sha256);
    assert.equal(r.manifest_sha256, sha(readFileSync(join(r.dir, 'manifest.json'))));
    assert.equal(verifyRaw({ root, runId: 'run-1', executionId: 'run-1-e00001' }).ok, true);
  } finally { done(); }
});

test('raw evidence is written once and never overwritten', () => {
  const { root, done } = tmp();
  try {
    const r = writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: LOG, capture: meta });
    assert.throws(() => writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: 'other', capture: meta }), /never overwritten/);
    assert.equal(readFileSync(join(r.dir, 'openshell-sandbox.log'), 'utf8'), LOG);
    try { writeFileSync(join(r.dir, 'openshell-sandbox.log'), 'tampered'); } catch { /* read-only: good */ }
  } finally { done(); }
});

test('sanitizing derives a separate layer, redacts credentials, keeps structure, and never touches the raw layer', () => {
  const { root, done } = tmp();
  try {
    const raw = writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: LOG, capture: meta });
    const before = Object.fromEntries(readdirSync(raw.dir).map(n => [n, sha(readFileSync(join(raw.dir, n)))]));
    const s = writeSanitizedEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', now: () => new Date('2026-11-02T10:03:00Z') });
    assert.notEqual(s.dir, raw.dir);
    assert.deepEqual(Object.fromEntries(readdirSync(raw.dir).map(n => [n, sha(readFileSync(join(raw.dir, n)))])), before, 'the raw layer is byte for byte unchanged');
    const text = readFileSync(join(s.dir, 'openshell-sandbox.sanitized.log'), 'utf8');
    for (const secret of ['abc123SECRET', 'sk-abcdefghijklmnopqrstuvwxyz0123456789', 'topsecret', 'SECRETKEY99']) assert.ok(!text.includes(secret), `${secret} is redacted`);
    assert.equal(text.split('\n').length, LOG.split('\n').length, 'the same number of lines');
    assert.match(text, /NET:OPEN \[INFO\] ALLOWED \/usr\/bin\/curl\(2232\) -> pypi\.org:443 \[policy:pypi engine:opa\]/, 'verdict, host, port, binary and policy are kept');
    assert.match(text, /DENIED .* \[reason:endpoint example\.com:443 is not allowed by any policy\]/);
    const events = readFileSync(join(s.dir, 'openshell-events.sanitized.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(events.length, raw.records);
    assert.ok(events.every(e => !('raw_line' in e) && /^[0-9a-f]{64}$/.test(e.raw_line_sha256)), 'hash references to the original lines, no original text');
    assert.deepEqual(events.map(e => e.decision), readFileSync(join(raw.dir, 'openshell-events.raw.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).decision), 'decisions are carried, not recomputed');
    const m = JSON.parse(readFileSync(join(s.dir, 'manifest.json'), 'utf8'));
    assert.deepEqual([m.sanitizer_version, m.raw_manifest_sha256, m.layer], [SANITIZER_VERSION, raw.manifest_sha256, 'sanitized']);
    assert.match(m.sanitizer_source_sha256, /^[0-9a-f]{64}$/);
    assert.equal(verifySanitized({ root, runId: 'run-1', executionId: 'run-1-e00001' }).ok, true);
    assert.throws(() => writeSanitizedEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001' }), /never overwritten/);
  } finally { done(); }
});

test('tampering with either layer is detected, and a damaged raw layer is never sanitized', () => {
  const { root, done } = tmp();
  try {
    const raw = writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: LOG, capture: meta });
    const s = writeSanitizedEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001' });
    const force = (file, content) => { try { writeFileSync(file, content); } catch { /* read-only */ } };
    const sanitizedFile = join(s.dir, 'openshell-sandbox.sanitized.log');
    force(sanitizedFile, 'changed');
    if (readFileSync(sanitizedFile, 'utf8') === 'changed') assert.equal(verifySanitized({ root, runId: 'run-1', executionId: 'run-1-e00001' }).ok, false);
    const t = tmp();
    try {
      const r2 = writeRawEvidence({ root: t.root, runId: 'run-2', executionId: 'run-2-e00001', text: LOG, capture: meta });
      const logFile = join(r2.dir, 'openshell-sandbox.log');
      force(logFile, LOG + 'an extra line\n');
      if (readFileSync(logFile, 'utf8') !== LOG) {
        assert.equal(verifyRaw({ root: t.root, runId: 'run-2', executionId: 'run-2-e00001' }).ok, false);
        assert.throws(() => writeSanitizedEvidence({ root: t.root, runId: 'run-2', executionId: 'run-2-e00001' }), /not intact/);
      }
    } finally { t.done(); }
    assert.equal(verifyRaw({ root, runId: 'run-9', executionId: 'run-9-e00001' }).ok, false, 'missing evidence is not intact');
    assert.equal(raw.records > 0, true);
  } finally { done(); }
});

test('events dropped from the structured file are detected', () => {
  const { root, done } = tmp();
  try {
    const raw = writeRawEvidence({ root, runId: 'run-1', executionId: 'run-1-e00001', text: LOG, capture: meta });
    const file = join(raw.dir, 'openshell-events.raw.jsonl');
    const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).join('\n') + '\n';
    try { writeFileSync(file, kept); } catch { return; }
    assert.match(verifyRaw({ root, runId: 'run-1', executionId: 'run-1-e00001' }).failures.join(), /hash|dropped/);
  } finally { done(); }
});

test('evidence paths are validated and contained', () => {
  const root = 'C:\\project';
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(81), 'a..b/../c', 'C:\\x']) {
    assert.throws(() => evidenceDir(root, 'raw', bad, 'run-1-e00001'), /not valid|leaves/, bad);
    assert.throws(() => evidenceDir(root, 'raw', 'run-1', bad), /not valid|leaves/, bad);
  }
  assert.throws(() => evidenceDir(root, 'other', 'run-1', 'e1'), /Unknown evidence layer/);
  assert.match(evidenceDir(root, 'raw', 'run-1', 'run-1-e00001').replaceAll('\\', '/'), /project\/\.local\/evidence\/raw\/run-1\/run-1-e00001$/);
});

test('the sanitizer redacts credential patterns and keeps analysis structure', () => {
  for (const [input, gone, kept] of [
    ['Authorization: Bearer abcdefghij0123456789', 'abcdefghij0123456789', 'Authorization'],
    ['Cookie: sid=zzz999; theme=dark', 'zzz999', 'Cookie'],
    ['GET /x?access_token=TOK123&page=2 HTTP/1.1', 'TOK123', 'page=2'],
    ['password=hunter2hunter2 user=bob', 'hunter2hunter2', 'user=bob'],
    ['ALLOWED GET https://example.com/a/b?secret=xyz#top [policy:p]', 'secret=xyz', '[policy:p]'],
    ['key sk-AAAAAAAAAAAAAAAAAAAAAAAA end', 'sk-AAAAAAAAAAAAAAAAAAAAAAAA', 'end'],
  ]) { const out = sanitizeLine(input); assert.ok(!out.includes(gone), `${gone} removed from: ${out}`); assert.ok(out.includes(kept), `${kept} kept in: ${out}`); }
  assert.equal(sanitizeLine('NET:OPEN [INFO] ALLOWED /usr/bin/curl(1) -> pypi.org:443'), 'NET:OPEN [INFO] ALLOWED /usr/bin/curl(1) -> pypi.org:443');
  const long = 'word '.repeat(4000).trim(); assert.equal(sanitizeLine(long).length, long.length, 'long lines are not truncated');
  assert.deepEqual(summarizeEvents(parseRaw('').records), { total: 0, by_category: {}, explicit_allow: 0, explicit_deny: 0, without_decision: 0 });
});
