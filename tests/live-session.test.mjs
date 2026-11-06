// The live Agent activity shown in the dashboard's OpenShell panel: session choice, the sandbox commands, and the chat built from an export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../tools/events-panel/openshell-events.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_EXPORT_DIR, SESSION_KEY, CHAT_ID, buildActivity, liveExportCommands, parseSessions, pickSession } from '../tools/events-panel/live-session.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const line = (seq, type, ts, data) => JSON.stringify({ seq, type, ts, sessionId: 's1', entryId: `e${seq}`, data });
const trajectory = [
  line(1, 'user.message', '2026-11-06T19:53:55.000Z', { message: { role: 'user', content: 'Use web_fetch on https://en.wikipedia.org/wiki/X' } }),
  line(2, 'prompt.submitted', '2026-11-06T19:53:55.100Z', { prompt: 'Use web_fetch on https://en.wikipedia.org/wiki/X' }),
  line(3, 'user.message', '2026-11-06T19:53:56.000Z', { message: { role: 'user', content: [{ type: 'text', text: '[Queued user message]' }], display: false } }),
  line(4, 'assistant.message', '2026-11-06T19:54:02.000Z', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'web_fetch', arguments: { url: 'https://en.wikipedia.org/wiki/X' } }], model: 'qwen2.5:1.5b' } }),
  line(5, 'tool.call', '2026-11-06T19:54:02.000Z', { toolCallId: 'c1', name: 'web_fetch', arguments: { url: 'https://en.wikipedia.org/wiki/X' }, assistantEntryId: 'e4' }),
  line(6, 'tool.result', '2026-11-06T19:54:02.400Z', { message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'CONNECT tunnel failed, response 403' }], isError: true } }),
  line(7, 'assistant.message', '2026-11-06T19:54:03.000Z', { message: { role: 'assistant', content: [{ type: 'text', text: 'The fetch was blocked.' }], model: 'qwen2.5:1.5b' } }),
  line(8, 'assistant.message', '2026-11-06T19:54:04.000Z', { message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Pending input is no longer active' } }),
].join('\n');
const denied = parseEvent(`[${Date.parse('2026-11-06T19:54:02.200Z') / 1000}] openshell-sandbox [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/node(42) -> en.wikipedia.org:443 [policy:- engine:opa] [reason:no matching policy]`);

test('the session list is read after any notice OpenClaw prints, newest first, and keys that are not plain words are dropped', () => {
  const out = 'Config (/sandbox/.openclaw/openclaw.json): Removed retired markers.\n' + JSON.stringify({ sessions: [
    { key: 'agent:main:main', status: 'done', updatedAt: 1 },
    { key: 'agent:main:dashboard:60d3-01', status: 'running', updatedAt: 3 },
    { key: 'agent:main:cron:d216', updatedAt: 4 },
    { key: 'agent:main:x; rm -rf /', updatedAt: 5 },
  ] });
  const sessions = parseSessions(out);
  assert.deepEqual(sessions.map(s => s.key), ['agent:main:cron:d216', 'agent:main:dashboard:60d3-01', 'agent:main:main']);
  assert.throws(() => parseSessions('no json here'), /did not list/);
});

test('the panel shows the newest chat (not a cron run) unless a session is chosen; an unknown or malformed choice is refused', () => {
  const sessions = parseSessions(JSON.stringify({ sessions: [{ key: 'agent:main:cron:a', updatedAt: 9 }, { key: 'agent:main:dashboard:b', updatedAt: 5 }, { key: 'agent:main:main', updatedAt: 1 }] }));
  assert.equal(pickSession(sessions).key, 'agent:main:dashboard:b');
  assert.equal(pickSession(sessions, '').key, 'agent:main:dashboard:b');
  assert.equal(pickSession(sessions, 'agent:main:main').key, 'agent:main:main');
  assert.throws(() => pickSession(sessions, 'agent:main:gone'), /no longer exists/);
  assert.throws(() => pickSession(sessions, 'agent:main:$(id)'), /not valid/);
  assert.equal(pickSession([]), null);
});

test('the sandbox commands are fixed words plus a checked session key, and the export folder is fixed', () => {
  const c = liveExportCommands('agent:main:dashboard:60d301ce-fdaf');
  assert.deepEqual(c.clear, ['rm', '-rf', LIVE_EXPORT_DIR]);
  assert.deepEqual(c.export, ['openclaw', 'sessions', 'export-trajectory', '--session-key', 'agent:main:dashboard:60d301ce-fdaf', '--output', 'openshell-panel-live', '--json']);
  assert.deepEqual(c.read, ['cat', `${LIVE_EXPORT_DIR}/events.jsonl`]);
  assert.equal(LIVE_EXPORT_DIR, '/sandbox/.openclaw/trajectory-exports/openshell-panel-live');
  for (const bad of ['agent:main:x y', 'agent:main:$HOME', 'agent:main:`id`', 'agent:main:a;b', 'agent:main:a|b', 'main', '']) {
    assert.equal(SESSION_KEY.test(bad), false, bad);
    assert.throws(() => liveExportCommands(bad), /not valid/, bad);
  }
});

test('the chat lists your messages, the Agent replies and each tool call with its result and the OpenShell decision logged for it', () => {
  const a = buildActivity({ trajectoryText: trajectory, events: [denied] });
  assert.deepEqual(a.items.map(i => i.kind), ['user', 'tool', 'assistant', 'assistant'], 'a queued re-send and the prompt copy are not shown twice; a tool-only reply is shown as its tool call');
  const tool = a.items[1];
  assert.equal(tool.name, 'web_fetch');
  assert.deepEqual(tool.arguments, { url: 'https://en.wikipedia.org/wiki/X' });
  assert.equal(tool.result.status, 'error');
  assert.match(tool.result.text, /403/);
  assert.equal(tool.openshell.decision, 'DENY');
  assert.equal(tool.openshell.verified, true);
  assert.equal(tool.events.length, 1);
  assert.equal(tool.events[0].host, 'en.wikipedia.org');
  assert.equal(a.items[3].error, 'Pending input is no longer active');
  assert.deepEqual(a.counts, { messages: 1, tool_calls: 1, allowed: 0, denied: 1, failed: 1 });
});

test('without a logged event the call has no decision, and a damaged export line is reported instead of guessed', () => {
  const a = buildActivity({ trajectoryText: `${trajectory}\n{not json`, events: [] });
  assert.equal(a.items[1].openshell.decision, null);
  assert.equal(a.items[1].openshell.source, 'unavailable');
  assert.deepEqual(a.unreadable_lines, [9]);
  assert.equal(buildActivity({ trajectoryText: '' }).items.length, 0);
});

test('long text is shortened for the panel and says how much was left out', () => {
  const long = 'x'.repeat(5000);
  const a = buildActivity({ trajectoryText: line(1, 'user.message', '2026-11-06T19:00:00.000Z', { message: { role: 'user', content: long } }) });
  assert.match(a.items[0].text, /… \(1000 more characters\)$/);
});

test('the chat open in the dashboard (/chat/main/<id>) is followed; an unknown id, no session yet or a hand-picked session keep their own rules', () => {
  const open = [
    { key: 'agent:main:dashboard:b2c3d4e5-1111-2222-3333-444455556666', updatedAt: 3 },
    { key: 'agent:main:dashboard:724d717a-473e-4aad-aeb3-24ef2081bf7e', updatedAt: 2 },
    { key: 'agent:main:main', updatedAt: 1 },
  ];
  assert.equal(pickSession(open, null, '724d717a').key, 'agent:main:dashboard:724d717a-473e-4aad-aeb3-24ef2081bf7e', 'the id in the address picks that chat, not the latest one');
  assert.equal(pickSession(open, null, 'ffffffff').key, 'agent:main:dashboard:b2c3d4e5-1111-2222-3333-444455556666', 'a chat with no session yet falls back to the latest');
  assert.equal(pickSession(open, 'agent:main:main', '724d717a').key, 'agent:main:main', 'a session picked by hand wins');
  assert.throws(() => pickSession(open, null, 'x; rm -rf /'), /chat id is not valid/);
  assert.ok(CHAT_ID.test('724d717a') && !CHAT_ID.test('main') && !CHAT_ID.test('724d717a/../x'));
});

test('the panel reads the open chat, polls every 2 s and overlaps its slow reads', () => {
  const ui = readFileSync(resolve(root, 'tools/events-panel/panel-ui.js'), 'utf8');
  const svc = readFileSync(resolve(root, 'tools/events-panel/panel-service.mjs'), 'utf8');
  assert.match(ui, /chatId: openChatId\(\)/);
  assert.match(ui, /}, 2000\);/);
  assert.match(svc, /const logsRead = run\(/, 'the OpenShell log is read while the session is exported');
  assert.match(svc, /never two exports at once/, 'the exports still never overlap: they share one folder');
});
