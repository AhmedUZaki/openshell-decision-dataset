import { createHash } from 'node:crypto';
import { posix } from 'node:path';

// Builds one record per OpenClaw tool call from a dedicated conversation.
// Decisions keep their provenance: observed OpenShell events, static-policy evaluation, or unavailable.
export const TOOL_CALL_SCHEMA = 'tool-call-0.1';
export const CONVERSATION_SCHEMA = 'conversation-0.1';
const RESULT_TEXT_LIMIT = 20000;
const WINDOW_BEFORE_MS = 250, WINDOW_AFTER_MS = 1000;

const fsTools = { read: 'read', ls: 'read', find: 'read', grep: 'read', write: 'write', edit: 'write', apply_patch: 'write' };
const processTools = new Set(['exec', 'process', 'bash', 'shell']);
const networkTools = new Set(['web_fetch', 'web_search', 'browser', 'fetch']);
const permissionError = /EACCES|EPERM|permission denied|operation not permitted|read-only file system/i;

export function toolDomain(name, args = {}) {
  if (fsTools[name]) return 'filesystem';
  if (processTools.has(name)) return 'process';
  if (networkTools.has(name) || typeof args.url === 'string') return 'network';
  return 'other';
}

// Parses the text table printed by `openshell policy list` (no JSON output in 0.0.116).
export function parsePolicyList(text) {
  return text.split(/\r?\n/).map(line => line.match(/^\s*(\d+)\s+([0-9a-f]+)\s+(\S+)\s+(\d+)\s*(.*)$/)).filter(Boolean)
    .map(([, version, hashPrefix, status, created, error]) => ({ version: Number(version), hash_prefix: hashPrefix, status, created_at_ms: Number(created), error: error.trim() || null }));
}

// The active revision at a moment is the latest one OpenShell reports as loaded at or before it.
export function activePolicyAt(versions, ms) {
  return versions.filter(v => Number.isFinite(v.loaded_at_ms) && v.loaded_at_ms <= ms).sort((a, b) => b.loaded_at_ms - a.loaded_at_ms)[0] || null;
}

// Landlock rules are additive: an access is granted when any covering rule grants it.
export function evaluateFilesystem(fsPolicy, path, access, workdir = null) {
  if (!fsPolicy) return { decision: null, rule: null, note: 'No filesystem policy in the active snapshot.' };
  if (typeof path !== 'string' || !path) return { decision: null, rule: null, note: 'Tool call has no path argument.' };
  if (!path.startsWith('/')) return { decision: null, rule: null, note: 'Relative path; the resolved location is not recorded.' };
  const target = posix.normalize(path);
  const entries = [
    ...(fsPolicy.read_only || []).map(entry => ({ section: 'read_only', entry })),
    ...(fsPolicy.read_write || []).map(entry => ({ section: 'read_write', entry })),
    ...(fsPolicy.include_workdir && workdir ? [{ section: 'workdir', entry: workdir }] : []),
  ];
  const covering = entries.filter(({ entry }) => { const base = entry.replace(/\/+$/, '') || '/'; return target === base || target.startsWith(base === '/' ? '/' : `${base}/`); })
    .sort((a, b) => b.entry.length - a.entry.length);
  const granting = covering.filter(r => access === 'read' || r.section !== 'read_only');
  if (granting.length) return { decision: 'ALLOW', rule: { kind: 'filesystem', section: granting[0].section, entry: granting[0].entry }, note: null };
  if (!covering.length && fsPolicy.include_workdir && !workdir) return { decision: null, rule: null, note: 'No listed rule covers the path and the sandbox workdir, which is also allowed, is unknown.' };
  return { decision: 'DENY', rule: covering.length ? { kind: 'filesystem', section: covering[0].section, entry: covering[0].entry } : { kind: 'filesystem', section: null, entry: null }, note: covering.length ? `Path is covered only by a read-only rule; ${access} access is not granted.` : 'No filesystem rule covers the path.' };
}

// What kind of failure the error text shows. This only separates ordinary execution errors from each other:
// none of these kinds is evidence of a policy decision. A permission error can come from Landlock or from
// ordinary Unix permissions, and a network error can come from DNS, the server or the proxy. Enforcement is
// proven only by an OpenShell ALLOWED/DENIED event (openshell.verified).
export function classifyFailure(text) {
  if (permissionError.test(text || '')) return 'permission_error';
  if (/ENOENT|no such file or directory|command not found|not found/i.test(text || '')) return 'not_found';
  if (/could not resolve|connection (?:refused|reset)|ECONN|ENOTFOUND|certificate|curl: \(\d+\)/i.test(text || '')) return 'network_error';
  if (/timed out|timeout|ETIMEDOUT/i.test(text || '')) return 'timeout';
  return 'command_failed';
}

function resultText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n');
}

// A sanity check of a decision against the tool's own output; it never produces a label.
//   consistent: the output shows what the decision implies (a proxy 403 for DENY, no block for ALLOW)
//   contradicts: the output shows the opposite (the call ran fine although DENY; a block although ALLOW)
//   inconclusive: the command failed in a way that says nothing about policy
// The sandbox shell prints a harmless "cannot create /proc/self/oom_score_adj: Permission denied" line on every command; it is ignored.
// exec reports a failed command as a normal result with "(Command exited with code N)", so the error flag alone is not enough.
const sandboxNoise = /\/bin\/(?:ba)?sh: \d+: cannot create \/proc\/self\/oom_score_adj: Permission denied/g;
const proxyDenied = /CONNECT tunnel failed, response 403/;
const failedExit = /\(Command exited with code [1-9]\d*\)/;
// OpenClaw's session export replaces some tool output (and arguments) with this marker; what the command printed is then unknown.
const hiddenOutput = /\[Malformed diagnostic JSON redacted\]/;
function consistency(decision, result) {
  if (!decision || result.status === 'missing') return 'inconclusive';
  const text = (result.text || '').replace(sandboxNoise, '');
  const blocked = proxyDenied.test(text) || (result.is_error && permissionError.test(text));
  // Output that was redacted cannot show or contradict anything.
  const failed = result.is_error || failedExit.test(text) || hiddenOutput.test(text);
  if (decision === 'DENY') return blocked ? 'consistent' : failed ? 'inconclusive' : 'contradicts';
  return blocked ? 'contradicts' : failed ? 'inconclusive' : 'consistent';
}

function eventSummary(e) {
  return { id: e.id, time: e.time, type: e.type, decision: e.decision, binary: e.binary, pid: e.pid, method: e.method, host: e.host, port: e.port, path: e.path, policy: e.policy, engine: e.engine, reason: e.reason };
}

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } }

// Hosts named by http(s) URLs inside a shell command, in order, without duplicates.
export function commandHosts(command) {
  if (typeof command !== 'string') return [];
  const hosts = [...command.matchAll(/https?:\/\/[^\s'"`)<>|;\\]+/gi)].map(m => hostOf(m[0])).filter(Boolean);
  return [...new Set(hosts)];
}

// The decision for a call that contacted the given hosts. Each host takes OpenShell's logged verdict (a DENIED
// event wins over ALLOWED for that host). The call carries one label only when every host got the same verdict:
// a call that was allowed to one host and denied to another is mixed and left unlabelled.
function observeHosts(hosts, candidates, attribution, ambiguousEvents = []) {
  const ambiguousIds = ambiguousEvents.map(e => e.id);
  const perHost = hosts.map(host => {
    const matched = candidates.filter(e => e.host === host && e.decision !== 'OBSERVED');
    const denied = matched.find(e => e.decision === 'DENIED');
    const decisive = denied || matched[0];
    return { host, decision: decisive ? (denied ? 'DENY' : 'ALLOW') : null, decisive, event_ids: matched.map(e => e.id) };
  });
  const decided = perHost.filter(h => h.decision);
  const eventIds = perHost.flatMap(h => h.event_ids);
  const detail = perHost.map(({ host, decision, decisive }) => ({ host, decision, policy: decisive?.policy ?? null }));
  // A host whose only logged evidence is shared with another tool call has no decision of its own: the call is not labelled.
  if (perHost.some(h => !h.decision && ambiguousEvents.some(e => e.host === h.host))) {
    return { decision: null, source: 'observed_event_ambiguous', rule: null, note: 'A logged event for this host could belong to more than one tool call (overlapping execution), so it is not used as this call\'s label.', attribution, event_ids: eventIds, ambiguous_event_ids: ambiguousIds, hosts: detail };
  }
  if (!decided.length) return { decision: null, source: 'unavailable', rule: null, note: 'No OpenShell decision for the requested host was logged during the call.', attribution: 'none', event_ids: [], ambiguous_event_ids: ambiguousIds, hosts: detail };
  const verdicts = new Set(decided.map(h => h.decision));
  if (verdicts.size > 1 || decided.length < perHost.length) {
    return { decision: null, source: 'observed_event_mixed', rule: null, note: 'The call contacted several hosts with different or missing OpenShell decisions; see hosts.', attribution, event_ids: eventIds, ambiguous_event_ids: ambiguousIds, hosts: detail };
  }
  const first = decided[0].decisive;
  return { decision: [...verdicts][0], source: 'observed_event', rule: { kind: 'network', policy: first.policy, engine: first.engine, reason: first.reason }, note: null, attribution, event_ids: eventIds, ambiguous_event_ids: ambiguousIds, hosts: detail };
}

// Gives each logged event to at most one tool call, so one request is never counted for two calls.
//   An event is a candidate for a call when it is for a host the call names and falls in the call's window:
//   strict = from 250 ms before the request to the result; grace = up to 1 s after the result (late log lines).
//   An event inside exactly one call's strict window belongs to that call, even if it is also in another call's grace.
//   Otherwise, if exactly one call claims it (strict, else grace) it belongs to that call.
//   If several calls claim it (parallel or overlapping calls) it is ambiguous: recorded for all of them, used by none.
export function attributeEvents(calls, events) {
  const assigned = new Map(), ambiguous = new Map(), ambiguousWith = new Map();
  const add = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  for (const e of events) {
    if (e.decision === 'OBSERVED' || !e.host) continue;
    const t = Date.parse(e.time);
    const named = calls.filter(c => c.hosts.includes(e.host));
    const end = c => c.completedMs ?? c.requestedMs;
    const strict = named.filter(c => t >= c.requestedMs - WINDOW_BEFORE_MS && t <= end(c));
    const grace = named.filter(c => t > end(c) && t <= end(c) + WINDOW_AFTER_MS);
    const claimants = strict.length ? strict : grace;
    if (claimants.length === 1) add(assigned, claimants[0].index, e.id);
    else if (claimants.length > 1) { claimants.forEach(c => add(ambiguous, c.index, e.id)); ambiguousWith.set(e.id, claimants.map(c => c.index)); }
  }
  return { assigned, ambiguous, ambiguousWith };
}

// Reads the Agent trajectory exported by OpenClaw, one JSON event per line. A line the exporter wrote as invalid JSON (OpenClaw can damage a line
// when it masks a secret-looking value) is not parsed and not guessed: it is reported by line number and left untouched in the saved file.
// One damaged line must never stop the evidence from being saved; the Dataset builder excludes such an execution with its reason.
export function parseTrajectory(text) {
  const events = [], unreadable = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (!line) return;
    try { events.push(JSON.parse(line)); } catch { unreadable.push(i + 1); }
  });
  return { events, unreadable };
}

export function buildToolCalls({ trajectoryText, events = [], policyVersions = [], policies = {}, conversationId, workdir = null }) {
  const trace = parseTrajectory(trajectoryText).events.sort((a, b) => a.seq - b.seq);
  const results = new Map(trace.filter(t => t.type === 'tool.result').map(t => [t.data?.message?.toolCallId, t]));
  const assistants = trace.filter(t => t.type === 'assistant.message');
  const runOf = t => t?.data?.message?.__openclaw?.runId || null;
  const assistantById = new Map(assistants.map(a => [a.entryId, a]));
  const toolEvents = events.filter(e => e.channel !== 'platform');
  const callList = trace.filter(t => t.type === 'tool.call');
  const hostsOf = (name, args = {}) => { const d = toolDomain(name, args); return d === 'network' ? [hostOf(args.url)].filter(Boolean) : d === 'process' ? commandHosts(args.command) : []; };
  const attribution = attributeEvents(callList.map((c, index) => { const r = results.get(c.data?.toolCallId); return { index, hosts: hostsOf(c.data?.name, c.data?.arguments), requestedMs: Date.parse(c.ts), completedMs: r ? Date.parse(r.ts) : null }; }), toolEvents);
  return callList.map((call, index) => {
    const { toolCallId, name, arguments: args = {} } = call.data || {};
    const resultEntry = results.get(toolCallId);
    const requestedMs = Date.parse(call.ts);
    const completedMs = resultEntry ? Date.parse(resultEntry.ts) : null;
    const runId = runOf(assistantById.get(call.data?.assistantEntryId)) || runOf(resultEntry) || null;
    const domain = toolDomain(name, args);
    const active = activePolicyAt(policyVersions, requestedMs);
    const policyJson = active ? policies[active.version]?.policy : null;

    const text = resultEntry ? resultText(resultEntry.data.message) : '';
    // OpenClaw reports a failed shell command as a normal result ending in "(Command exited with code N)"; is_error is what it reported,
    // status also counts a non-zero exit code.
    const exitMatch = /\(Command exited with code (\d+)\)/.exec(text);
    const exitCode = exitMatch ? Number(exitMatch[1]) : null;
    const failed = resultEntry ? Boolean(resultEntry.data.message.isError) || (exitCode !== null && exitCode !== 0) : false;
    const result = resultEntry
      ? { status: failed ? 'error' : 'ok', is_error: Boolean(resultEntry.data.message.isError), exit_code: exitCode, text: text.slice(0, RESULT_TEXT_LIMIT), truncated: text.length > RESULT_TEXT_LIMIT, sha256: createHash('sha256').update(text).digest('hex'), completed_at: resultEntry.ts, failure_kind: failed ? classifyFailure(text) : null }
      : { status: 'missing', is_error: null, exit_code: null, text: null, truncated: false, sha256: null, completed_at: null, failure_kind: null };

    const windowEnd = (completedMs ?? requestedMs) + WINDOW_AFTER_MS;
    const candidates = toolEvents.filter(e => { const t = Date.parse(e.time); return t >= requestedMs - WINDOW_BEFORE_MS && t <= windowEnd; });
    const mineIds = attribution.assigned.get(index) || new Set(), ambiguousIds = attribution.ambiguous.get(index) || new Set();
    const mine = toolEvents.filter(e => mineIds.has(e.id)), ambiguousEvents = toolEvents.filter(e => ambiguousIds.has(e.id));
    let openshell;
    if (domain === 'filesystem') {
      const evaluation = evaluateFilesystem(policyJson?.filesystem_policy, args.path ?? args.file_path, fsTools[name], workdir);
      openshell = { decision: evaluation.decision, source: evaluation.decision ? 'derived_from_static_policy' : 'unavailable', rule: evaluation.rule, note: evaluation.note, attribution: 'policy_evaluation', event_ids: [], ambiguous_event_ids: [] };
      if (policyJson?.landlock?.compatibility && policyJson.landlock.compatibility !== 'hard_requirement') openshell.caveat = `Landlock compatibility is ${policyJson.landlock.compatibility}; kernel enforcement was not independently confirmed.`;
    } else if (domain === 'network' && hostOf(args.url)) {
      openshell = observeHosts([hostOf(args.url)], mine, 'host_match_time_window', ambiguousEvents);
    } else if (domain === 'process' && commandHosts(args.command).length) {
      // A command that names URLs makes network requests: its decision comes from the logged events for those hosts.
      openshell = observeHosts(commandHosts(args.command), mine, 'command_url_time_window', ambiguousEvents);
    } else {
      openshell = { decision: null, source: 'unavailable', rule: null, note: domain === 'process' ? 'OpenShell logs process launches, not an allow/deny decision for the command. Effects inside it appear as separate filesystem or network evidence.' : 'No decision source is defined for this tool.', attribution: 'none', event_ids: [], ambiguous_event_ids: [] };
    }

    // True only when OpenShell itself logged the verdict. Derived, mixed and missing decisions are never verified.
    openshell.verified = openshell.source === 'observed_event' && (openshell.decision === 'ALLOW' || openshell.decision === 'DENY');

    const response = resultEntry ? assistants.find(a => a.seq > resultEntry.seq && (!runId || runOf(a) === runId)) : null;
    const responseMessage = response?.data?.message;
    return {
      schema_version: TOOL_CALL_SCHEMA,
      record_id: `${conversationId}:${toolCallId}`,
      conversation_id: conversationId,
      session_id: call.sessionId,
      run_id: runId,
      tool_call_id: toolCallId,
      sequence: index + 1,
      requested_at: call.ts,
      tool: { name, domain, arguments: args },
      policy: active ? { version: active.version, hash: active.hash, basis: 'loaded_at_ms' } : { version: null, hash: null, basis: 'unavailable' },
      openshell,
      candidate_events: candidates.map(eventSummary),
      result,
      evidence_consistency: consistency(openshell.decision, result),
      openclaw_response: responseMessage ? {
        entry_id: response.entryId, ts: response.ts, stop_reason: responseMessage.stopReason || null,
        text: resultText({ content: (responseMessage.content || []).filter(p => p.type === 'text') }),
        tool_call_ids: (responseMessage.content || []).filter(p => p.type === 'toolCall').map(p => p.id),
      } : null,
      ground_truth_verified: false,
    };
  });
}

// Compact view of a record for the panel; the full record stays in tool-calls.jsonl.
export function toolCallSummary(c) {
  const a = c.tool.arguments || {};
  const target = String(a.path ?? a.file_path ?? a.url ?? a.command ?? '').slice(0, 200);
  const r = c.openshell.rule;
  const rule = !r ? null : r.kind === 'filesystem' ? (r.section ? `${r.section}: ${r.entry}` : 'no filesystem rule covers the path') : `policy ${r.policy || '-'}${r.engine ? ` (${r.engine})` : ''}${r.reason ? ` — ${r.reason}` : ''}`;
  return {
    sequence: c.sequence, tool: c.tool.name, domain: c.tool.domain, target, requested_at: c.requested_at,
    policy_version: c.policy.version, decision: c.openshell.decision, source: c.openshell.source, rule, note: c.openshell.note,
    result: c.result.status, consistency: c.evidence_consistency,
    response: c.openclaw_response ? (c.openclaw_response.text || (c.openclaw_response.tool_call_ids.length ? `[next tool call ${c.openclaw_response.tool_call_ids.join(', ')}]` : '')).slice(0, 300) : null,
  };
}

// Tool execution outcome (stored as task_outcome for compatibility), read from the Agent's own tool results. It says how the tool calls ended, not
// whether the natural-language task was achieved. It is kept apart from collection status and never used as a label: an ALLOW or DENY still comes
// only from an OpenShell event.
//   Succeeded  every recorded tool call finished without an error
//   Failed     every recorded tool call has a result and every result is an error
//   Partial    a mixture of successful, failed or missing results (one error plus one missing result is Partial: it is not known that every call failed)
//   Unknown    no tool call, or no recorded result at all
export function taskOutcome(toolCalls) {
  const ok = toolCalls.filter(c => c.result?.status === 'ok').length;
  const error = toolCalls.filter(c => c.result?.status === 'error').length;
  const missing = toolCalls.length - ok - error;
  let value = 'Unknown';
  if (toolCalls.length) {
    if (ok && !error && !missing) value = 'Succeeded';
    else if (error && !ok && !missing) value = 'Failed';
    else if ((ok && (error || missing)) || (error && missing)) value = 'Partial';
  }
  return { value, tool_calls: toolCalls.length, succeeded: ok, failed: error, without_result: missing, note: 'Tool execution outcome, from the Agent\'s tool results; not a label, not collection status, and not proof that the task objective was achieved.' };
}

export function conversationRecord({ conversationId, title, task, sandboxName, sandboxId, sessionKey, sessionId, model, versions, policyVersions, toolCalls, trajectoryText }) {
  const trace = parseTrajectory(trajectoryText).events;
  const runs = [...new Set(trace.map(t => t.data?.message?.__openclaw?.runId).filter(Boolean))];
  const count = key => toolCalls.reduce((acc, c) => { const k = key(c) ?? 'null'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  return {
    schema_version: CONVERSATION_SCHEMA,
    conversation_id: conversationId,
    task: { title, requested_text: task, source: 'user_entered_task_not_auto_sent' },
    sandbox: { name: sandboxName, id: sandboxId, isolation: 'dedicated_per_conversation' },
    session: { key: sessionKey, id: sessionId, run_ids: runs },
    configured_model: model,
    versions,
    policy_versions: policyVersions.map(v => ({ version: v.version, hash: v.hash, status: v.status, created_at_ms: v.created_at_ms, loaded_at_ms: v.loaded_at_ms })),
    messages_ref: 'trajectory/events.jsonl',
    tool_calls_ref: 'tool-calls.jsonl',
    tool_call_count: toolCalls.length,
    decision_counts: count(c => c.openshell.decision),
    decision_source_counts: count(c => c.openshell.source),
    ground_truth_verified: false,
  };
}
