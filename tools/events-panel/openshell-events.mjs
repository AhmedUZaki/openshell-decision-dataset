import { createHash } from 'node:crypto';

export function redact(value, limit = 800) {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/https?:\/\/[^\s\]]+/g, match => {
      try { const u = new URL(match); return `${u.protocol}//${u.host}${u.pathname}`; }
      catch { return '[URL redacted]'; }
    })
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*)[^\s\],]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{40,})\b/g, '[identifier redacted]')
    .slice(0, limit);
}

// Endpoints used by the platform itself (model inference, gateway), never by an agent tool.
const platformHosts = new Set(['host.openshell.internal', 'inference.local']);

// OpenShell's reason can itself contain brackets ("ancestors: [...]", "cmdline: [...]"), so it runs to the bracket that closes "[reason:",
// not to the first "]". If the line was cut before that bracket, what is there is kept. OpenShell may end a long reason with "..." itself.
export const REASON_LIMIT = 4000;
export function readReason(detail) {
  const start = detail.indexOf('[reason:');
  if (start < 0) return null;
  const from = start + '[reason:'.length;
  let depth = 0;
  for (let i = start; i < detail.length; i++) {
    if (detail[i] === '[') depth++;
    else if (detail[i] === ']' && --depth === 0) return detail.slice(from, i);
  }
  return detail.slice(from);
}

// Structured fields are read from the raw line so policy names survive redaction of the display detail.
export function eventFields(detail) {
  const fields = { binary: null, pid: null, method: null, host: null, port: null, path: null, policy: null, engine: null, reason: null };
  const proc = detail.match(/(?:^|\s)((?:\/|[A-Za-z])[^\s()]*)\((\d+)\)/);
  if (proc) { fields.binary = proc[1]; fields.pid = Number(proc[2]); }
  const http = detail.match(/\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(https?:\/\/[^\s\]]+)/);
  if (http) {
    fields.method = http[1];
    try { const u = new URL(http[2]); fields.host = u.hostname; fields.port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); fields.path = u.pathname; } catch {}
  } else {
    const target = detail.match(/->\s+([A-Za-z0-9.-]+):(\d+)/) || detail.match(/^(?:ALLOWED\s+|DENIED\s+)?([A-Za-z0-9.-]+\.[A-Za-z]+|\d+\.\d+\.\d+\.\d+):(\d+)/);
    if (target) { fields.host = target[1].toLowerCase(); fields.port = Number(target[2]); }
  }
  const policy = detail.match(/\[policy:([^\s\]]+)(?:\s+engine:([^\s\]]+))?\]/);
  if (policy) { fields.policy = policy[1] === '-' ? null : policy[1]; fields.engine = policy[2] || null; }
  const reason = readReason(detail);
  if (reason !== null) fields.reason = redact(reason, REASON_LIMIT);
  return fields;
}

export function parseEvent(line) {
  const match = line.match(/^\[(\d+(?:\.\d+)?)\].*?\[ocsf\]\s+([A-Z_]+:[A-Z_]+)\s+\[([^\]]+)\]\s*(.*)$/);
  if (!match) return null;
  const [, timestamp, type, severity, detail] = match;
  // Configuration and relay events are not tool-policy decisions. HTTP carries L7 method/path decisions.
  if (!/^(NET|HTTP|FS|PROC|PROCESS):/.test(type)) return null;
  if (/ssh relay|127\.0\.0\.1:18789|localhost:18789/i.test(detail)) return null;
  const decision = /\bDENIED\b/.test(detail) ? 'DENIED' : /\bALLOWED\b/.test(detail) ? 'ALLOWED' : 'OBSERVED';
  const fields = eventFields(detail);
  return {
    id: createHash('sha256').update(line).digest('hex').slice(0, 20),
    time: new Date(Number(timestamp) * 1000).toISOString(),
    type, severity: severity.trim(), decision,
    detail: redact(detail),
    ...fields,
    channel: platformHosts.has(fields.host) ? 'platform' : 'sandbox',
    correlation: 'sandbox_only',
  };
}
