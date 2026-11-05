import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../tools/events-panel/openshell-events.mjs';
import { activePolicyAt, attributeEvents, buildToolCalls, classifyFailure, commandHosts, conversationRecord, evaluateFilesystem, parsePolicyList, parseTrajectory, taskOutcome, toolCallSummary } from '../tools/events-panel/tool-calls.mjs';

const fsPolicy = { include_workdir: true, read_only: ['/usr', '/etc'], read_write: ['/tmp', '/sandbox/.openclaw'] };
const policies = { 1: { policy: { filesystem_policy: fsPolicy, landlock: { compatibility: 'best_effort' } } }, 2: { policy: { filesystem_policy: { ...fsPolicy, read_write: ['/tmp'] } } } };
const versions = [
  { version: 1, hash: 'a'.repeat(64), status: 'Superseded', created_at_ms: Date.parse('2026-11-01T10:00:00Z'), loaded_at_ms: Date.parse('2026-11-01T10:00:01Z') },
  { version: 2, hash: 'b'.repeat(64), status: 'Loaded', created_at_ms: Date.parse('2026-11-01T10:05:00Z'), loaded_at_ms: Date.parse('2026-11-01T10:05:01Z') },
];

// Book-summary conversation: read, write, exec, fetch, then a write after the policy changed.
function line(seq, type, ts, data, entryId = `e${seq}`) { return JSON.stringify({ seq, type, ts, sessionId: 's1', entryId, data }); }
function assistant(seq, ts, content, runId = 'run-1') { return line(seq, 'assistant.message', ts, { message: { role: 'assistant', content, stopReason: 'toolUse', __openclaw: { runId } } }, `a${seq}`); }
function call(seq, ts, id, name, args, assistantSeq) { return line(seq, 'tool.call', ts, { toolCallId: id, name, arguments: args, assistantEntryId: `a${assistantSeq}` }); }
function result(seq, ts, id, text, isError = false) { return line(seq, 'tool.result', ts, { message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError } }); }
const trajectoryText = [
  assistant(1, '2026-11-01T10:01:00.000Z', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/sandbox/.openclaw/workspace/book.md' } }]),
  call(2, '2026-11-01T10:01:00.000Z', 'c1', 'read', { path: '/sandbox/.openclaw/workspace/book.md' }, 1),
  result(3, '2026-11-01T10:01:00.100Z', 'c1', 'Chapter 1 ...'),
  assistant(4, '2026-11-01T10:01:02.000Z', [{ type: 'toolCall', id: 'c2', name: 'write', arguments: { path: '/usr/share/summary.md', content: 'x' } }]),
  call(5, '2026-11-01T10:01:02.000Z', 'c2', 'write', { path: '/usr/share/summary.md', content: 'x' }, 4),
  result(6, '2026-11-01T10:01:02.050Z', 'c2', 'EACCES: permission denied, open /usr/share/summary.md', true),
  assistant(7, '2026-11-01T10:01:03.000Z', [{ type: 'toolCall', id: 'c3', name: 'exec', arguments: { command: 'pandoc summary.md -o summary.pdf' } }]),
  call(8, '2026-11-01T10:01:03.000Z', 'c3', 'exec', { command: 'pandoc summary.md -o summary.pdf' }, 7),
  result(9, '2026-11-01T10:01:03.500Z', 'c3', 'pandoc: command not found', true),
  assistant(10, '2026-11-01T10:01:04.000Z', [{ type: 'toolCall', id: 'c4', name: 'web_fetch', arguments: { url: 'https://example.test/book' } }]),
  call(11, '2026-11-01T10:01:04.000Z', 'c4', 'web_fetch', { url: 'https://example.test/book' }, 10),
  result(12, '2026-11-01T10:01:04.300Z', 'c4', 'Request blocked', true),
  assistant(13, '2026-11-01T10:06:00.000Z', [{ type: 'toolCall', id: 'c5', name: 'write', arguments: { path: '/sandbox/.openclaw/workspace/summary.md', content: 'y' } }]),
  call(14, '2026-11-01T10:06:00.000Z', 'c5', 'write', { path: '/sandbox/.openclaw/workspace/summary.md', content: 'y' }, 13),
  result(15, '2026-11-01T10:06:00.050Z', 'c5', 'EACCES: permission denied', true),
  assistant(16, '2026-11-01T10:06:01.000Z', [{ type: 'text', text: 'I could not save the summary.' }]),
].join('\n');
const sec = iso => (Date.parse(iso) / 1000).toFixed(3);
const events = [
  `[${sec('2026-11-01T10:01:04.200Z')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/node(9) -> example.test:443 [policy:- engine:opa] [reason:endpoint example.test:443 is not allowed by any policy]`,
  `[${sec('2026-11-01T10:01:04.250Z')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/node(9) -> telemetry.openclaw.ai:443 [policy:- engine:opa] [reason:not allowed]`,
  `[${sec('2026-11-01T10:01:04.260Z')}] [sandbox] [OCSF ] [ocsf] HTTP:POST [INFO] ALLOWED /usr/bin/python3(5) -> POST http://host.openshell.internal:11435/v1/chat/completions [policy:p engine:l7]`,
].map(parseEvent);

test('policy history parses the CLI table and selects the revision loaded at call time', () => {
  const listed = parsePolicyList('VERSION  HASH           STATUS       CREATED                  ERROR\n2        8b2ac4ddc0bc   Loaded       1793570846204\n1        9b274313586d   Superseded   1793570841314\n');
  assert.deepEqual(listed.map(v => [v.version, v.hash_prefix, v.status]), [[2, '8b2ac4ddc0bc', 'Loaded'], [1, '9b274313586d', 'Superseded']]);
  assert.equal(activePolicyAt(versions, Date.parse('2026-11-01T10:03:00Z')).version, 1);
  assert.equal(activePolicyAt(versions, Date.parse('2026-11-01T10:05:00.500Z')).version, 1);
  assert.equal(activePolicyAt(versions, Date.parse('2026-11-01T10:06:00Z')).version, 2);
  assert.equal(activePolicyAt(versions, Date.parse('2026-11-01T09:00:00Z')), null);
});

test('filesystem rules are additive and unknown coverage stays unlabelled', () => {
  assert.equal(evaluateFilesystem(fsPolicy, '/usr/lib/x', 'read').decision, 'ALLOW');
  assert.deepEqual(evaluateFilesystem(fsPolicy, '/usr/lib/x', 'write').rule, { kind: 'filesystem', section: 'read_only', entry: '/usr' });
  assert.equal(evaluateFilesystem(fsPolicy, '/usr/lib/x', 'write').decision, 'DENY');
  assert.equal(evaluateFilesystem(fsPolicy, '/tmp/../etc/passwd', 'write').decision, 'DENY');
  assert.equal(evaluateFilesystem(fsPolicy, '/tmpfoo', 'read').decision, null);
  assert.equal(evaluateFilesystem({ ...fsPolicy, include_workdir: false }, '/tmpfoo', 'read').decision, 'DENY');
  assert.equal(evaluateFilesystem(fsPolicy, '/opt/a', 'read', '/opt').decision, 'ALLOW');
  assert.equal(evaluateFilesystem(fsPolicy, 'book.md', 'read').decision, null);
});

test('each tool call becomes one record with its policy, decision, result and response', () => {
  const calls = buildToolCalls({ trajectoryText, events, policyVersions: versions, policies, conversationId: 'conv-0123456789' });
  assert.equal(calls.length, 5);
  const [read, write, exec, fetch, late] = calls;
  assert.deepEqual([read.tool.domain, read.policy.version, read.openshell.decision, read.openshell.source, read.evidence_consistency], ['filesystem', 1, 'ALLOW', 'derived_from_static_policy', 'consistent']);
  assert.equal(read.openshell.rule.entry, '/sandbox/.openclaw');
  assert.match(read.openshell.caveat, /best_effort/);
  assert.equal(read.openclaw_response.tool_call_ids[0], 'c2');
  assert.equal(read.run_id, 'run-1');
  assert.deepEqual([write.openshell.decision, write.evidence_consistency], ['DENY', 'consistent']);
  assert.deepEqual([exec.tool.domain, exec.openshell.decision, exec.openshell.source], ['process', null, 'unavailable']);
  assert.deepEqual([fetch.openshell.decision, fetch.openshell.source, fetch.openshell.attribution, fetch.openshell.event_ids.length], ['DENY', 'observed_event', 'host_match_time_window', 1]);
  assert.match(fetch.openshell.rule.reason, /example\.test/);
  assert.ok(fetch.candidate_events.some(e => e.host === 'telemetry.openclaw.ai'), 'background events stay visible as candidates');
  assert.ok(!fetch.candidate_events.some(e => e.host === 'host.openshell.internal'), 'model inference is not a tool candidate');
  // Version 2 dropped the rule; the workdir may still cover the path, so no label is invented.
  assert.deepEqual([late.policy.version, 'snapshot_ref' in late.policy, late.openshell.decision, late.openshell.source], [2, false, null, 'unavailable']);
  assert.equal(buildToolCalls({ trajectoryText, events, policyVersions: versions, policies, conversationId: 'r', workdir: '/sandbox/work' })[4].openshell.decision, 'DENY');
  assert.equal(late.openclaw_response.text, 'I could not save the summary.');
  assert.ok(calls.every(c => c.ground_truth_verified === false));
  const conversation = conversationRecord({ conversationId: 'conv-0123456789', title: 't', task: 'Summarize a book and save it', sandboxName: 'conv-0123456789', sandboxId: '7a7d70c0-935a-4bc2-9a5f-933c19c7cda8', sessionKey: 'agent:main:main', sessionId: 's1', model: 'm', versions: { openshell: 'x', openclaw: 'y' }, policyVersions: versions, toolCalls: calls, trajectoryText });
  assert.deepEqual(conversation.decision_counts, { ALLOW: 1, DENY: 2, null: 2 });
  assert.deepEqual(conversation.session.run_ids, ['run-1']);
  const summaries = calls.map(toolCallSummary);
  assert.deepEqual([summaries[0].rule, summaries[0].response], ['read_write: /sandbox/.openclaw', '[next tool call c2]']);
  assert.match(summaries[3].rule, /^policy - \(opa\) — endpoint example\.test/);
  assert.deepEqual([summaries[2].decision, summaries[2].target], [null, 'pandoc summary.md -o summary.pdf']);
});

test('exec commands that name URLs take the logged decision of those hosts', () => {
  const cmds = [
    'curl -sS https://raw.githubusercontent.com/git/git/master/README.md | head -n 5',
    'curl -sS -m 15 https://example.test/',
    'curl https://raw.githubusercontent.com/a && curl https://example.test/x',
    'curl -sS https://nothing-logged.test/',
    'ls /tmp',
  ];
  const lines = cmds.flatMap((command, i) => {
    const ts = `2026-11-01T10:0${i}:00.000Z`;
    return [assistant(i * 3 + 1, ts, [{ type: 'toolCall', id: `x${i}`, name: 'exec', arguments: { command } }]), call(i * 3 + 2, ts, `x${i}`, 'exec', { command }, i * 3 + 1), result(i * 3 + 3, `2026-11-01T10:0${i}:00.500Z`, `x${i}`, 'ok')];
  }).join('\n');
  const at = (i, s) => sec(`2026-11-01T10:0${i}:00.${s}Z`);
  const evs = [
    `[${at(0, '200')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(7) -> raw.githubusercontent.com:443 [policy:brew-balanced engine:opa]`,
    `[${at(1, '200')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(7) -> example.test:443 [policy:- engine:opa] [reason:not allowed]`,
    `[${at(2, '200')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(7) -> raw.githubusercontent.com:443 [policy:brew-balanced engine:opa]`,
    `[${at(2, '300')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(8) -> example.test:443 [policy:- engine:opa] [reason:not allowed]`,
  ].map(parseEvent);
  const calls = buildToolCalls({ trajectoryText: lines, events: evs, policyVersions: versions, policies, conversationId: 'conv-0123456789' });
  const [allow, deny, mixed, none, plain] = calls.map(c => c.openshell);
  assert.deepEqual([allow.decision, allow.source, allow.attribution, allow.rule.policy], ['ALLOW', 'observed_event', 'command_url_time_window', 'brew-balanced']);
  assert.deepEqual([deny.decision, deny.source, deny.rule.reason], ['DENY', 'observed_event', 'not allowed']);
  assert.deepEqual([mixed.decision, mixed.source, mixed.hosts], [null, 'observed_event_mixed', [{ host: 'raw.githubusercontent.com', decision: 'ALLOW', policy: 'brew-balanced' }, { host: 'example.test', decision: 'DENY', policy: null }]]);
  assert.deepEqual([none.decision, none.source], [null, 'unavailable']);
  assert.deepEqual([plain.decision, plain.source], [null, 'unavailable']);
  assert.deepEqual(commandHosts('python3 -c "import urllib.request as u; u.urlopen(\'https://huggingface.co/api/models?limit=1\')" ; curl http://a.test:8080/x | cat'), ['huggingface.co', 'a.test']);
});


test('failures are classified as execution errors and only OpenShell-logged verdicts are verified', () => {
  assert.deepEqual(['EACCES: permission denied, open /usr/x', 'ENOENT: no such file or directory', 'curl: (6) Could not resolve host: x', 'request timed out', 'exit code 1'].map(classifyFailure), ['permission_error', 'not_found', 'network_error', 'timeout', 'command_failed']);
  const calls = buildToolCalls({ trajectoryText, events, policyVersions: versions, policies, conversationId: 'conv-0123456789' });
  const [read, write, exec, fetch] = calls;
  assert.deepEqual(calls.map(c => c.openshell.verified), [false, false, false, true, false], 'only the fetch has an OpenShell event');
  assert.deepEqual([write.result.failure_kind, exec.result.failure_kind, read.result.failure_kind, fetch.result.failure_kind], ['permission_error', 'not_found', null, 'command_failed']);
  assert.equal(write.openshell.verified, false, 'a permission error on a filesystem call is not enforcement proof');
});

test('an event belongs to at most one tool call: sequential calls are told apart, concurrent ones are ambiguous', () => {
  const calls = [
    { index: 0, hosts: ['a.test'], requestedMs: 1000, completedMs: 1250 },
    { index: 1, hosts: ['a.test'], requestedMs: 1600, completedMs: 1800 },
    { index: 2, hosts: ['b.test'], requestedMs: 1000, completedMs: 1250 },
  ];
  const ev = (id, time, host = 'a.test', decision = 'ALLOWED') => ({ id, time: new Date(time).toISOString(), host, decision });
  const { assigned, ambiguous, ambiguousWith } = attributeEvents(calls, [ev('own0', 1100), ev('own1', 1700), ev('late', 2600), ev('both', 2000), ev('far', 5000), ev('nohost', 1100, null), ev('seen', 1100, 'a.test', 'OBSERVED'), ev('other', 1100, 'b.test')]);
  assert.deepEqual([...assigned.get(0)], ['own0'], 'call 0 keeps its own event, not the one inside call 1 though it is within call 0 grace (1 s after its result)');
  assert.deepEqual([...assigned.get(1)], ['own1', 'late'], 'a late line inside only one call\'s grace');
  assert.deepEqual([ambiguousWith.get('both'), [...ambiguous.keys()]], [[0, 1], [0, 1]], 'inside the grace of two calls and the running time of neither');
  assert.deepEqual([...assigned.get(2)], ['other']);
  // two calls running at the same time to the same host: the event cannot be told apart
  const parallel = attributeEvents([{ index: 0, hosts: ['a.test'], requestedMs: 1000, completedMs: 1500 }, { index: 1, hosts: ['a.test'], requestedMs: 1100, completedMs: 1600 }], [ev('x', 1300)]);
  assert.deepEqual([parallel.assigned.size, [...parallel.ambiguous.get(0)], [...parallel.ambiguous.get(1)], parallel.ambiguousWith.get('x')], [0, ['x'], ['x'], [0, 1]]);
  // two calls in their grace only (neither running): still ambiguous
  const graceOnly = attributeEvents([{ index: 0, hosts: ['a.test'], requestedMs: 0, completedMs: 100 }, { index: 1, hosts: ['a.test'], requestedMs: 50, completedMs: 150 }], [ev('g', 900)]);
  assert.deepEqual(graceOnly.ambiguousWith.get('g'), [0, 1]);
});

test('building tool calls gives each request to one call and withholds the label when it is shared', () => {
  const cmd = 'curl -sS https://pypi.org/x';
  const t = ms => new Date(Date.UTC(2026, 10, 2, 10, 0, 0, ms)).toISOString();
  const traj = (spec) => spec.flatMap(([id, req, done], i) => [
    assistant(i * 3 + 1, t(req), [{ type: 'toolCall', id, name: 'exec', arguments: { command: cmd } }]), call(i * 3 + 2, t(req), id, 'exec', { command: cmd }, i * 3 + 1), result(i * 3 + 3, t(done), id, 'ok'),
  ]).join('\n');
  const line = (ms, id = 7) => `[${(Date.UTC(2026, 10, 2, 10, 0, 0, ms) / 1000).toFixed(3)}] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/bin/curl(${id}) -> pypi.org:443 [policy:pypi engine:opa]`;
  // sequential: call 2 starts 350 ms after call 1 ended, so call 1's one-second grace overlaps call 2
  const seq = events => buildToolCalls({ trajectoryText: traj([['c1', 0, 250], ['c2', 600, 800]]), events: events.map(parseEvent), policyVersions: versions, policies, conversationId: 'r' });
  const evs = [line(100), line(700, 8)].map(parseEvent);
  const [first, second] = buildToolCalls({ trajectoryText: traj([['c1', 0, 250], ['c2', 600, 800]]), events: evs, policyVersions: versions, policies, conversationId: 'r' });
  assert.deepEqual([first.openshell.event_ids, second.openshell.event_ids], [[evs[0].id], [evs[1].id]], 'each call takes only its own request');
  assert.deepEqual([first.openshell.verified, second.openshell.verified, first.openshell.ambiguous_event_ids, second.openshell.ambiguous_event_ids], [true, true, [], []]);
  // parallel: both calls were running when the request was logged
  const shared = [line(300)].map(parseEvent);
  const [p1, p2] = buildToolCalls({ trajectoryText: traj([['c1', 0, 500], ['c2', 100, 600]]), events: shared, policyVersions: versions, policies, conversationId: 'r' });
  for (const p of [p1, p2]) assert.deepEqual([p.openshell.decision, p.openshell.source, p.openshell.verified, p.openshell.event_ids, p.openshell.ambiguous_event_ids], [null, 'observed_event_ambiguous', false, [], [shared[0].id]]);
  assert.equal(seq([]).length, 2);
});

test('evidence check reads the proxy 403 and exit code, ignores the sandbox shell noise, and never makes a label', () => {
  const noise = '/bin/bash: 1: cannot create /proc/self/oom_score_adj: Permission denied';
  const build = (decision, text) => {
    const cmd = 'curl -sS https://x.test/';
    const lines = [assistant(1, '2026-11-01T10:00:00.000Z', [{ type: 'toolCall', id: 'k1', name: 'exec', arguments: { command: cmd } }]), call(2, '2026-11-01T10:00:00.000Z', 'k1', 'exec', { command: cmd }, 1), result(3, '2026-11-01T10:00:00.500Z', 'k1', text)].join('\n');
    const ev = [`[${sec('2026-11-01T10:00:00.200Z')}] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ${decision} /usr/bin/curl(7) -> x.test:443 [policy:${decision === 'ALLOWED' ? 'p' : '-'} engine:opa]`].map(parseEvent);
    return buildToolCalls({ trajectoryText: lines, events: ev, policyVersions: versions, policies, conversationId: 'r' })[0];
  };
  assert.equal(build('DENIED', noise + ' curl: (56) CONNECT tunnel failed, response 403 (Command exited with code 56)').evidence_consistency, 'consistent');
  assert.equal(build('DENIED', noise + ' hello').evidence_consistency, 'contradicts', 'the call ran fine although OpenShell denied it');
  assert.equal(build('DENIED', noise + ' curl: (6) Could not resolve host (Command exited with code 6)').evidence_consistency, 'inconclusive');
  assert.equal(build('ALLOWED', noise + ' <html>ok</html>').evidence_consistency, 'consistent', 'the sandbox shell noise is not a block');
  assert.equal(build('ALLOWED', noise + ' curl: (56) CONNECT tunnel failed, response 403').evidence_consistency, 'contradicts');
  assert.equal(build('ALLOWED', noise + ' curl: (7) Failed to connect (Command exited with code 7)').evidence_consistency, 'inconclusive');
  assert.equal(build('DENIED', noise + ' curl: (56) CONNECT tunnel failed, response 403').openshell.decision, 'DENY', 'the label comes from the OpenShell event only');
  assert.equal(build('DENIED', '[Malformed diagnostic JSON redacted]').evidence_consistency, 'inconclusive', 'redacted output shows nothing, so it cannot contradict the verdict');
});

test('a command that exits non-zero is an error even when OpenClaw reports the result as normal', () => {
  const cmd = 'curl -sS https://x.test/';
  const run = text => buildToolCalls({ trajectoryText: [assistant(1, '2026-11-01T10:00:00.000Z', [{ type: 'toolCall', id: 'k1', name: 'exec', arguments: { command: cmd } }]), call(2, '2026-11-01T10:00:00.000Z', 'k1', 'exec', { command: cmd }, 1), result(3, '2026-11-01T10:00:00.500Z', 'k1', text)].join('\n'), events: [], policyVersions: versions, policies, conversationId: 'r' })[0].result;
  const failed = run('curl: (56) CONNECT tunnel failed, response 403 (Command exited with code 56)');
  assert.deepEqual([failed.status, failed.is_error, failed.exit_code, failed.failure_kind], ['error', false, 56, 'network_error'], 'is_error stays what OpenClaw reported; status counts the exit code');
  const quiet = run('boom (Command exited with code 2)');
  assert.deepEqual([quiet.status, quiet.exit_code, quiet.failure_kind], ['error', 2, 'command_failed']);
  const fine = run('hello');
  assert.deepEqual([fine.status, fine.exit_code, fine.failure_kind], ['ok', null, null]);
  assert.equal(run('done (Command exited with code 0)').status, 'ok');
});

test('tool execution outcome (task_outcome): Succeeded, Failed, Partial or Unknown from the tool results only', () => {
  const call = status => ({ result: { status } });
  assert.equal(taskOutcome([]).value, 'Unknown', 'no tool call: nothing to judge');
  assert.equal(taskOutcome([call('ok'), call('ok')]).value, 'Succeeded');
  assert.equal(taskOutcome([call('error'), call('error')]).value, 'Failed');
  assert.equal(taskOutcome([call('ok'), call('error')]).value, 'Partial');
  assert.equal(taskOutcome([call('missing')]).value, 'Unknown', 'a call without a result');
  assert.equal(taskOutcome([call('ok'), call('missing')]).value, 'Partial');
  assert.equal(taskOutcome([call('error'), call('missing')]).value, 'Partial', 'one error and one missing result is not "every call failed"');
  assert.equal(taskOutcome([call('error'), call('error'), call('missing')]).value, 'Partial');
  assert.equal(taskOutcome([call('missing'), call('missing')]).value, 'Unknown');
  assert.deepEqual(taskOutcome([call('ok'), call('error'), call('missing')]), { value: 'Partial', tool_calls: 3, succeeded: 1, failed: 1, without_result: 1, note: taskOutcome([]).note });
});
test('a damaged trajectory line is reported by number and skipped; saving the other events is never stopped by it', () => {
  const lines = trajectoryText.split('\n');
  const damaged = [...lines.slice(0, 3), lines[3].slice(0, 30) + '\u2026' + lines[3].slice(-5), ...lines.slice(4)].join('\n');
  const parsed = parseTrajectory(damaged);
  assert.deepEqual(parsed.unreadable, [4]);
  assert.equal(parsed.events.length, lines.filter(Boolean).length - 1);
  assert.deepEqual(parseTrajectory(trajectoryText).unreadable, []);
  assert.deepEqual(parseTrajectory('').events, []);
  const calls = buildToolCalls({ trajectoryText: damaged, events: [], policyVersions: versions, policies, conversationId: 'conv-x' });
  assert.ok(calls.length > 0, 'the readable Tool Calls are still built');
  const record = conversationRecord({ conversationId: 'conv-x', title: 't', task: 'x', sandboxName: 's', sandboxId: 'i', sessionKey: 'k', sessionId: 's1', model: 'm', versions: {}, policyVersions: versions, toolCalls: calls, trajectoryText: damaged });
  assert.equal(record.tool_call_count, calls.length);
});
