// Sandboxes reach Ollama only through NemoClaw's authentication proxy (port 11435), which stops when Windows or WSL restarts.
// Start OpenClaw.cmd and Generate Dataset.cmd must both make sure it runs, with one shared script that never exposes its token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(resolve(root, rel), 'utf8');
const script = read('tools/launchers/ensure-ollama-proxy.sh');

test('the proxy script is plain LF bash that checks first and starts NemoClaw\'s own proxy only when it is down', () => {
  assert.ok(script.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(!script.includes('\r'), 'LF line endings only');
  assert.match(script, /answers\(\)/, 'it checks whether the proxy already answers');
  assert.match(script, /"401"/, 'a 401 to an unauthenticated request proves the proxy owns the port');
  assert.ok(script.indexOf('if answers; then echo "running"') < script.indexOf('setsid nohup'), 'it returns before starting anything when the proxy already answers');
  assert.match(script, /scripts\/ollama-auth-proxy\.mts/);
  assert.match(script, /exit 1/, 'it fails loudly when it cannot start the proxy');
});

test('the proxy script never prints, copies or logs the token', () => {
  const lines = script.split('\n').filter(l => /ollama-proxy-token/.test(l));
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    const readsIt = /cat\s+"\$state\/ollama-proxy-token"/.test(l);
    if (readsIt) assert.match(l, /^OLLAMA_PROXY_TOKEN="\$\(cat "\$state\/ollama-proxy-token"\)"/, `the token is read only into the new process's environment: ${l}`);
    else assert.match(l, /\[ ! -s "\$state\/ollama-proxy-token" \]/, `otherwise the file is only tested for existence: ${l}`);
  }
  assert.doesNotMatch(script, /echo[^\n]*(OLLAMA_PROXY_TOKEN|\$token)/);
});

test('Start OpenClaw checks the proxy before it probes the sandbox', () => {
  const ps = read('tools/launchers/Start-OpenClaw.ps1');
  assert.match(ps, /ensure-ollama-proxy\.sh/);
  assert.ok(ps.indexOf('Invoke-OllamaProxyCheck\n') < ps.indexOf('connect --probe-only'), 'the proxy is ensured before the connect probe');
  assert.match(ps, /ToBase64String/, 'the script is passed as base64: a PowerShell 5.1 pipe adds a byte-order mark');
  assert.match(ps, /could not be started/);
});

test('Generate Dataset checks the proxy in its preflight', () => {
  const adapter = read('safety-router-dataset/collect-data/system-adapter.mjs');
  assert.match(adapter, /ensure-ollama-proxy\.sh/);
  assert.match(adapter, /Ollama authentication proxy answers/);
});
