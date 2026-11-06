// The live Agent activity of the shared my-assistant sandbox, for the OpenShell panel in its dashboard.
// It reads the chat a person is having right now: their messages, the Agent's replies and every tool call with its result and
// the OpenShell decision logged for it. Read-only and for viewing only: nothing here is saved as evidence or used as a label.
import { buildToolCalls, parseTrajectory } from './tool-calls.mjs';

export const LIVE_EXPORT_DIR = '/sandbox/.openclaw/trajectory-exports/openshell-panel-live';
export const SESSION_KEY = /^agent:[A-Za-z0-9._:-]{1,200}$/;
const TEXT_LIMIT = 4000;

// The commands run inside the sandbox, in order: remove the fixed export folder (the exporter refuses an existing one), export the session with
// OpenClaw's own exporter, print its events, remove the folder again. wsl.exe hands its arguments to a shell, so every argument here is a fixed
// word or a session key that SESSION_KEY has already limited to letters, digits and . _ : - (no quoting, no shell syntax).
export function liveExportCommands(sessionKey) {
  if (!SESSION_KEY.test(String(sessionKey))) throw Error('The session key is not valid.');
  return {
    clear: ['rm', '-rf', LIVE_EXPORT_DIR],
    export: ['openclaw', 'sessions', 'export-trajectory', '--session-key', sessionKey, '--output', 'openshell-panel-live', '--json'],
    read: ['cat', `${LIVE_EXPORT_DIR}/events.jsonl`],
  };
}

// `openclaw sessions --json` can print a config notice before its JSON.
export function parseSessions(output) {
  const text = String(output || '');
  const start = text.indexOf('{');
  if (start < 0) throw Error('OpenClaw did not list its sessions.');
  const sessions = JSON.parse(text.slice(start)).sessions || [];
  return sessions.filter(s => SESSION_KEY.test(String(s.key))).map(s => ({ key: s.key, status: s.status ?? null, sessionId: s.sessionId ?? null, updatedAt: s.updatedAt ?? null }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// The session the panel shows: the one asked for, else the most recently updated chat (scheduled cron runs are not chats).
export function pickSession(sessions, requested = null) {
  if (requested !== null && requested !== undefined && requested !== '') {
    if (!SESSION_KEY.test(String(requested))) throw Error('The session key is not valid.');
    const found = sessions.find(s => s.key === requested);
    if (!found) throw Error('That session no longer exists.');
    return found;
  }
  return sessions.find(s => !s.key.includes(':cron:')) || sessions[0] || null;
}

const clip = text => { const t = String(text ?? ''); return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT)}\n… (${t.length - TEXT_LIMIT} more characters)` : t; };
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';
const eventView = e => ({ time: e.time, type: e.type, decision: e.decision, host: e.host, port: e.port, method: e.method, policy: e.policy, reason: e.reason, binary: e.binary });

// The chat in order: the person's messages, the Agent's replies and its tool calls, each call with its result and OpenShell decision.
export function buildActivity({ trajectoryText, events = [] }) {
  const { events: trace, unreadable } = parseTrajectory(trajectoryText);
  trace.sort((a, b) => a.seq - b.seq);
  const calls = new Map(buildToolCalls({ trajectoryText, events, conversationId: 'my-assistant' }).map(c => [c.tool_call_id, c]));
  const items = [];
  for (const t of trace) {
    const m = t.data?.message;
    if (t.type === 'user.message') {
      if (m?.display === false) continue;   // a queued message OpenClaw re-sends as context; the person's own message is already listed
      items.push({ kind: 'user', ts: t.ts, text: clip(textOf(m?.content)) });
    } else if (t.type === 'assistant.message') {
      const text = textOf(m?.content).trim();
      const error = m?.stopReason === 'error' ? String(m.errorMessage || 'The model request failed.') : null;
      if (text || error) items.push({ kind: 'assistant', ts: t.ts, text: clip(text), model: m?.model ?? null, error });
    } else if (t.type === 'tool.call') {
      const c = calls.get(t.data?.toolCallId);
      if (!c) continue;
      const o = c.openshell;
      items.push({
        kind: 'tool', ts: t.ts, id: c.tool_call_id, name: c.tool.name, domain: c.tool.domain, arguments: c.tool.arguments,
        result: { status: c.result.status, exit_code: c.result.exit_code, text: c.result.text === null ? null : clip(c.result.text), completed_at: c.result.completed_at },
        openshell: { decision: o.decision, source: o.source, verified: o.verified, note: o.note ?? null, hosts: o.hosts ?? null,
          rule: o.rule ? (o.rule.kind === 'filesystem' ? `${o.rule.section ?? 'no rule'}: ${o.rule.entry ?? ''}` : `policy ${o.rule.policy ?? '-'}${o.rule.engine ? ` (${o.rule.engine})` : ''}`) : null },
        events: c.candidate_events.map(eventView),
      });
    }
  }
  const tools = items.filter(i => i.kind === 'tool');
  return {
    items,
    counts: { messages: items.filter(i => i.kind === 'user').length, tool_calls: tools.length, allowed: tools.filter(i => i.openshell.decision === 'ALLOW').length, denied: tools.filter(i => i.openshell.decision === 'DENY').length, failed: tools.filter(i => i.result.status === 'error').length },
    unreadable_lines: unreadable,
  };
}
