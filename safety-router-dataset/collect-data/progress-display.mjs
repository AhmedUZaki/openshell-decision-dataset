// Progress display for the CMD collector. Pure rendering plus a small renderer that draws in place on a terminal and falls back to
// bounded, line-based updates when the terminal cannot redraw (output redirected, TERM=dumb, no TTY). Full detail goes to the run files.
import { POLICIES } from './collection-selection.mjs';

const BLOCK = '█', EMPTY = '-';
export function bar(done, total, width = 30) {
  const t = Math.max(0, total), d = Math.min(Math.max(0, done), t || 0);
  const filled = t ? Math.round(width * d / t) : 0;
  const pct = t ? Math.floor(100 * d / t) : 0;
  return `[${BLOCK.repeat(filled)}${EMPTY.repeat(width - filled)}] ${d}/${t} — ${pct}%`;
}
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s` : `${m}m ${String(r).padStart(2, '0')}s`;
}
const n = v => Number(v ?? 0).toLocaleString('en-US');
const cut = (text, width) => width && text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;

// The lines of the progress block for one state. Every line is bounded by `columns`.
export function renderProgress(state, { columns = 100, barWidth = 30 } = {}) {
  const t = state.totals ?? {}, c = state.current;
  const total = state.executions.length;
  const label = id => POLICIES.find(p => p.id === id)?.label ?? id;
  const running = state.status === 'running';
  const lines = [
    `Collection run   ${state.run_id}`,
    `Overall          ${bar(t.completed ?? 0, total, barWidth)}`,
    `Stage            ${state.stage ?? '-'}${state.status !== 'running' ? `   (${state.status})` : ''}`,
    `Category         ${c?.category ?? '-'}`,
    `Task             ${c ? `${c.task_number}/${c.tasks_total} — ${c.task_title}` : '-'}`,
    `Policy           ${c ? `${c.policy_number}/${c.policies_total} — ${label(c.policy)}` : '-'}`,
    `Separate run     ${c ? `${c.separate_run}/${c.runs_total}` : '-'}`,
    `Execution        ${c ? c.execution_id : '-'}`,
    `Conversation     ${c?.conversation_id ?? '-'}      Sandbox ${c?.sandbox_id ?? '-'}`,
    `Completed        ${n(t.completed)}      Saved bundles ${n(t.bundles)}      Failures ${n(t.failed)}`,
    `OpenShell        raw events ${n(t.raw_events)} · explicit ALLOW ${n(t.explicit_allow)} · explicit DENY ${n(t.explicit_deny)} · without labels ${n(t.without_label)}`,
    `Tool execution outcome  Succeeded ${n(t.task_outcomes?.Succeeded)} · Failed ${n(t.task_outcomes?.Failed)} · Partial ${n(t.task_outcomes?.Partial)} · Unknown ${n(t.task_outcomes?.Unknown)} · truncated evidence ${n(t.truncated_evidence)}`,
    `Time             elapsed ${duration(state.elapsed_seconds)} · remaining ${running ? `about ${duration(state.remaining_seconds)}` : '-'}`,
  ];
  return lines.map(l => cut(l, columns));
}

// One bounded line for terminals that cannot redraw.
export function renderLine(state, { columns = 100, barWidth = 20 } = {}) {
  const c = state.current, t = state.totals ?? {};
  const where = c ? ` ${c.execution_id.split('-e').pop() ? `e${c.execution_id.split('-e').pop()}` : ''} ${c.task_id} ${c.policy} run ${c.separate_run}` : '';
  return cut(`${bar(t.completed ?? 0, state.executions.length, barWidth)} ${state.stage ?? '-'}${where}${t.failed ? ` failures ${t.failed}` : ''}`, columns);
}

// Draws a state on a stream. In place when the stream is a terminal that supports it; otherwise one line when the stage, the execution or the
// outcome changes (at most once per `minIntervalMs`, so a long run does not flood the console).
export class ProgressRenderer {
  constructor({ stream = process.stdout, tty = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb', columns = process.stdout.columns || 100, now = () => Date.now(), minIntervalMs = 10000, minDrawMs = 200 } = {}) {
    Object.assign(this, { stream, tty, columns, now, minIntervalMs, minDrawMs });
    this.drawn = 0; this.lastKey = null; this.lastAt = -Infinity; this.lastDraw = -Infinity;
  }
  update(state, { force = false } = {}) {
    const t = this.now();
    if (this.tty) {
      if (!force && t - this.lastDraw < this.minDrawMs) return;
      this.lastDraw = t;
      const lines = renderProgress(state, { columns: this.columns });
      this.stream.write(`${this.drawn ? `\x1b[${this.drawn}A\x1b[0J` : ''}${lines.join('\n')}\n`);
      this.drawn = lines.length;
      return;
    }
    const key = `${state.stage}|${state.current?.execution_id ?? ''}|${state.status}`;
    if (key === this.lastKey && !force) return;
    if (!force && t - this.lastAt < this.minIntervalMs && state.status === 'running' && this.lastKey?.split('|')[1] === key.split('|')[1]) return;
    this.lastKey = key; this.lastAt = t;
    this.stream.write(renderLine(state, { columns: this.columns }) + '\n');
  }
  // After the run: leave the last block on screen and stop redrawing.
  finish(state) { this.update(state, { force: true }); this.drawn = 0; }
}
