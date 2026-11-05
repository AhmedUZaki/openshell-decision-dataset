import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, redact } from '../tools/events-panel/openshell-events.mjs';

test('explicit denial is retained with its reason', () => {
  const e = parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/node(12) -> example.test:443 [reason:endpoint not allowed]');
  assert.equal(e.decision, 'DENIED');
  assert.match(e.detail, /endpoint not allowed/);
  assert.equal(e.correlation, 'sandbox_only');
});
test('an observed connection is not invented as an allow decision', () => {
  assert.equal(parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] example.test:443').decision, 'OBSERVED');
});
test('an explicit allow is identified', () => {
  assert.equal(parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED example.test:443').decision, 'ALLOWED');
});
test('configuration and dashboard relay noise is excluded', () => {
  assert.equal(parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] CONFIG:ENABLED [INFO] Landlock'), null);
  assert.equal(parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] 127.0.0.1:18789/tcp'), null);
  assert.equal(parseEvent('[1793569290.310] [sandbox] [OCSF ] [ocsf] SSH:OPEN [INFO] ALLOWED'), null);
});
test('process and L7 HTTP events are parsed with their rule fields', () => {
  assert.equal(parseEvent('[1793570841.446] [sandbox] [OCSF ] [ocsf] PROC:LAUNCH [INFO] env(57)').pid, 57);
  const http = parseEvent('[1793570854.656] [sandbox] [OCSF ] [ocsf] HTTP:GET [INFO] ALLOWED GET http://catalog.openclaw.ai:443/models/v1/catalog.json?k=private [policy:openclaw_api engine:l7]');
  assert.deepEqual([http.decision, http.method, http.host, http.port, http.path, http.policy, http.engine], ['ALLOWED', 'GET', 'catalog.openclaw.ai', 443, '/models/v1/catalog.json', 'openclaw_api', 'l7']);
  assert.ok(!http.detail.includes('private'));
  const denied = parseEvent('[1793570854.548] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/node(1348) -> telemetry.openclaw.ai:443 [policy:- engine:opa] [reason:endpoint telemetry.openclaw.ai:443 is not allowed by any policy]');
  assert.deepEqual([denied.binary, denied.pid, denied.host, denied.policy, denied.engine, denied.channel], ['/usr/local/bin/node', 1348, 'telemetry.openclaw.ai', null, 'opa', 'sandbox']);
  assert.match(denied.reason, /not allowed by any policy/);
  assert.equal(parseEvent('[1793570853.119] [sandbox] [OCSF ] [ocsf] HTTP:POST [INFO] ALLOWED /usr/bin/python3.13(1544) -> POST http://host.openshell.internal:11435/v1/chat/completions [policy:p engine:l7]').channel, 'platform');
});
test('duplicate input has stable identity and common secrets are redacted', () => {
  const line = '[1793569290.310] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] DENIED example.test:443';
  assert.equal(parseEvent(line).id, parseEvent(line).id);
  const redacted = redact('https://example.test/x?token=private#secret Bearer abc password=hello api_key=world');
  for (const secret of ['private', '#secret', 'abc', 'hello', 'world']) assert.ok(!redacted.includes(secret));
});

test('a denial reason runs to the bracket that closes it, even when it contains brackets itself', () => {
  const line = '[1793656603.577] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(2218) -> docs.openclaw.ai:443 [policy:- engine:opa] [reason:binary \'/usr/bin/curl\' not allowed in policy \'openclaw_docs\' (ancestors: [/usr/bin/bash -> /usr/local/bin/node], cmdline: [/dev/null, /bin/bash]). SYMLINK HINT: the binary path is the kernel-resolved target f...]';
  const ev = parseEvent(line);
  assert.equal(ev.reason, "binary '/usr/bin/curl' not allowed in policy 'openclaw_docs' (ancestors: [/usr/bin/bash -> /usr/local/bin/node], cmdline: [/dev/null, /bin/bash]). SYMLINK HINT: the binary path is the kernel-resolved target f...");
  assert.equal(parseEvent('[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> a.test:443 [policy:- engine:opa] [reason:endpoint a.test:443 is not allowed by any policy]').reason, 'endpoint a.test:443 is not allowed by any policy');
  assert.equal(parseEvent('[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(1) -> a.test:443 [policy:p engine:opa]').reason, null);
  assert.equal(parseEvent('[1.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> a.test:443 [policy:- engine:opa] [reason:cut (ancestors: [/bin/bash').reason, 'cut (ancestors: [/bin/bash', 'a line cut before the closing bracket keeps what is there');
});
