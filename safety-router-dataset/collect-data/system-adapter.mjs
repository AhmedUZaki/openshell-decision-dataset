// The real system behind the collector: the panel API on 127.0.0.1:18891, WSL, Docker, child processes, the filesystem and the clock.
// Tests never import this file for execution; they give the collector a mock context instead.
import { readFileSync, writeFileSync, mkdirSync, statfsSync, existsSync, readdirSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import { loadCatalog } from './task-catalog.mjs';
import { POLICY_IDS } from './collection-selection.mjs';
import { orphanSandboxes, shellScript, activeRun } from './collection-runner.mjs';
import { bundleEvidence } from '../../tools/events-panel/provenance.mjs';
import { folderBytes } from '../../tools/events-panel/evidence.mjs';
import { buildOutcomeRecord, stopReasons } from '../../tools/events-panel/single-action-record.mjs';

const DOCKER = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const MAX_SANDBOXES = 4;
const CAPTURE = /^capture-[a-f0-9]{24}$/;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

export function makeContext({ root, print = null }) {
  const exec = promisify(execFile);
  const dirs = { captures: resolve(root, '.local/task-captures'), runs: resolve(root, '.local/runs'), previews: resolve(root, '.local/dataset-previews'), evidence: resolve(root, '.local/evidence') };
  const state = () => JSON.parse(readFileSync(resolve(root, '.local/openshell-panel-state.json'), 'utf8'));
  const folder = captureId => { if (!CAPTURE.test(String(captureId))) throw Error('The capture id is not valid.'); return resolve(dirs.captures, captureId); };

  // Every call carries the capability header and the main panel's origin (or a sandbox's own, for Save), as the panel's own page does.
  const panel = (path, body, { origin = 'http://127.0.0.1:18789', conversation, timeout = 900000 } = {}) => new Promise((res, rej) => {
    const data = body === null ? '' : JSON.stringify(body);
    const headers = { Host: '127.0.0.1:18891', Origin: origin, 'X-OpenShell-Panel': state().capability };
    if (body !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (conversation) headers['X-OpenShell-Conversation'] = conversation;
    const req = http.request({ host: '127.0.0.1', port: 18891, path, method: body === null ? 'GET' : 'POST', headers, timeout }, resp => {
      let text = ''; resp.on('data', c => { if (text.length < 2_000_000) text += c; });
      resp.on('end', () => { try { res({ status: resp.statusCode, body: JSON.parse(text) }); } catch { res({ status: resp.statusCode, body: text }); } });
    });
    req.on('error', rej); req.on('timeout', () => req.destroy(Error('timeout'))); req.end(data);
  });
  const wsl = (...args) => exec('wsl.exe', ['-d', 'Ubuntu-24.04', '--', ...args], { timeout: 30000, windowsHide: true });
  const openshell = () => `/home/${state().linuxUser}/.local/bin/openshell`;

  // The natural-language task goes to the Agent as one quoted word of a script file; it is never interpreted as a command.
  const sendTask = async (id, text) => {
    const scripts = resolve(dirs.runs, '_send'); mkdirSync(scripts, { recursive: true });
    const script = resolve(scripts, `send-${id}.sh`);
    writeFileSync(script, shellScript(id, text));
    const wslPath = `/mnt/${script[0].toLowerCase()}${script.slice(2).replaceAll('\\', '/')}`;
    try { return (await exec('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'bash', wslPath], { timeout: 480000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout; }
    catch (e) { return `ERROR ${String(e.stdout || '')}${String(e.stderr || e.message).slice(0, 300)}`; }
  };
  // How many log lines OpenShell holds for a sandbox: used to wait until the event stream has stopped growing.
  const logLineCount = async id => { try { return (await exec('wsl.exe', ['-d', 'Ubuntu-24.04', '--', openshell(), 'logs', id, '--source', 'sandbox', '-n', '100000'], { timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true })).stdout.split('\n').length; } catch { return -1; } };

  // The raw log boundary of a Single-Action Policy Test: how many non-blank lines OpenShell holds for the sandbox right now. Read-only; null when unreadable.
  const logBoundary = async id => {
    try {
      const out = (await exec('wsl.exe', ['-d', 'Ubuntu-24.04', '--', openshell(), 'logs', id, '--source', 'sandbox', '-n', '100000'], { timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true })).stdout;
      const n = out.split('\n').filter(l => l.trim()).length;
      return { line_count: n, cursor: n };
    } catch { return null; }
  };

  // The policy fingerprint of a sandbox right now (OpenShell's own revision number and hash of the effective policy). Read-only; null when unreadable.
  const policyBoundary = async id => {
    try {
      const p = JSON.parse((await exec('wsl.exe', ['-d', 'Ubuntu-24.04', '--', openshell(), 'policy', 'get', id, '--full', '--output', 'json'], { timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout);
      return typeof p.hash === 'string' && p.hash ? { version: p.version ?? null, hash: p.hash } : null;
    } catch { return null; }
  };

  // Judges one saved Bundle exactly as the Dataset exporter will (read-only): its three outcomes, its routing and any reason that must stop the collection.
  const assessExecution = captureId => {
    const { record } = buildOutcomeRecord(root, captureId);
    const o = record.outcomes;
    return { stop: stopReasons(record), routing: record.routing.output, openshell_policy_decision: o.openshell_policy_decision.value, decision_evidence_status: o.openshell_policy_decision.evidence_status,
      task_result: o.task_result.value, action_result_after_openshell: o.action_result_after_openshell.value, reasons: record.routing.reasons };
  };

  // Export, validation and verification run as the same scripts a person would run, with fixed arguments.
  const runNode = args => new Promise(res => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = c => { output = (output + c).slice(-8000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', e => res({ code: 1, output: String(e.message) }));
    child.on('close', code => res({ code: code ?? 1, output }));
  });

  const bundleStatus = captureId => {
    const f = folder(captureId);
    const e = bundleEvidence(f);
    const missing = [...e.missing, ...(existsSync(resolve(f, 'execution.json')) ? [] : ['execution.json'])];
    return { complete: missing.length === 0, missing };
  };
  // What earlier bundles say about size and yield (only a sample of them is read).
  const historyStats = () => {
    if (!existsSync(dirs.captures)) return {};
    const names = readdirSync(dirs.captures).filter(n => CAPTURE.test(n)).slice(0, 60);
    if (!names.length) return {};
    let events = 0, decided = 0, bytes = 0;
    for (const n of names) {
      const f = resolve(dirs.captures, n);
      bytes += folderBytes(f);
      const lines = existsSync(resolve(f, 'openshell-events.jsonl')) ? readFileSync(resolve(f, 'openshell-events.jsonl'), 'utf8').split('\n').filter(Boolean) : [];
      events += lines.length;
      decided += lines.filter(l => /"decision":"(ALLOWED|DENIED)"/.test(l)).length;
    }
    const out = { bundles: names.length, avg_bundle_bytes: Math.round(bytes / names.length), avg_events: events / names.length };
    if (events) out.decision_ratio = decided / events;
    const raw = resolve(dirs.evidence, 'raw');
    if (existsSync(raw)) { const b = folderBytes(raw); const k = readdirSync(raw).reduce((a, r) => a + readdirSync(resolve(raw, r)).length, 0); if (k) out.avg_evidence_bytes = Math.round(2 * b / k); }
    return out;
  };

  const serviceBuildHash = () => {
    const base = resolve(root, 'tools/events-panel');
    const files = readFileSync(resolve(base, 'service-files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    return createHash('sha256').update(Buffer.concat(files.map(f => readFileSync(resolve(base, f))))).digest('hex');
  };

  // Runs tools/launchers/ensure-ollama-proxy.sh in Ubuntu through stdin (so its line endings never matter). Resolves with its one-line result; rejects with its message.
  const ensureOllamaProxy = () => new Promise((res, rej) => {
    const script = readFileSync(resolve(root, 'tools/launchers/ensure-ollama-proxy.sh'), 'utf8').replace(/\r/g, '');
    const child = execFile('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'bash', '-s'], { timeout: 90000, windowsHide: true }, (error, stdout) => {
      const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
      if (error) rej(Error(line || error.message)); else res(line);
    });
    child.stdin.on('error', () => {}); child.stdin.end(script);
  });

  // The system checks of the preview. They only read, except the proxy check below: nothing is created or run.
  const systemChecks = async (selection, remaining) => {
    const results = [];
    const check = async (name, fn) => { try { const r = await fn(); results.push({ name, status: r.status || 'PASS', detail: r.detail }); } catch (e) { results.push({ name, status: 'FAIL', detail: String(e.message).slice(0, 220) }); } };
    let items = [];
    await check('Docker answers', async () => ({ detail: `server ${(await exec(DOCKER, ['info', '--format', '{{.ServerVersion}}'], { timeout: 30000, windowsHide: true })).stdout.trim()}` }));
    await check('WSL Ubuntu-24.04 answers', async () => ({ detail: (await wsl('uname', '-sr')).stdout.trim() }));
    await check('OpenShell answers', async () => ({ detail: (await wsl(openshell(), '--version')).stdout.trim() }));
    await check('OpenClaw panel service answers, at the expected version', async () => {
      const h = await panel('/health', null);
      if (h.status !== 200 || h.body?.service !== 'openshell-panel') throw Error(`/health returned ${h.status}; start OpenClaw.cmd first`);
      const expected = serviceBuildHash();
      if (h.body.build !== expected) throw Error('the running panel service is not the code in this folder; run Start OpenClaw Workspace.cmd to restart it');
      const l = await panel('/conversations/list', null);
      if (l.status !== 200) throw Error(`/conversations/list returned ${l.status}`);
      items = l.body.items;
      return { detail: `build ${expected.slice(0, 12)}; ${items.length} conversation(s) exist` };
    });
    await check('Ollama answers', async () => ({ detail: (await wsl('curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:11434/api/version')).stdout.trim() }));
    // Sandboxes reach Ollama only through NemoClaw's authentication proxy. It stops when Windows or WSL restarts, and every inference request then
    // fails with 502. This is the one check that may start something: it starts NemoClaw's own proxy (see tools/launchers/ensure-ollama-proxy.sh).
    await check('Ollama authentication proxy answers (started when it was down)', async () => ({ detail: await ensureOllamaProxy() }));
    await check('the configured model is installed', async () => {
      const pins = Object.fromEntries(readFileSync(resolve(root, 'setup/pins.env'), 'utf8').split(/\r?\n/).map(l => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]));
      if (!(await wsl('ollama', 'list')).stdout.includes(pins.MODEL)) throw Error(`model ${pins.MODEL} is not installed`);
      return { detail: pins.MODEL };
    });
    await check('every selected policy can be created', async () => {
      if (selection.policies.some(p => !POLICY_IDS.includes(p))) throw Error('a policy outside restricted, balanced, open');
      return { detail: selection.policies.join(', ') };
    });
    await check('sandboxes: room for one more, none being created', async () => {
      if (items.some(i => i.status === 'creating')) throw Error('a sandbox is still being created');
      const live = items.filter(i => i.status === 'ready' || i.status === 'creating').length;
      if (live >= MAX_SANDBOXES) throw Error(`${live} sandboxes exist; the limit is ${MAX_SANDBOXES}. Delete finished ones in the panel first`);
      return { detail: `${live} of ${MAX_SANDBOXES} in use` };
    });
    // A container the panel does not list holds evidence nobody has looked at: a new collection does not start until a person has.
    await check('no unaccounted sandbox containers', async () => {
      const names = (await exec(DOCKER, ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000, windowsHide: true })).stdout.split(/\r?\n/).filter(Boolean);
      const orphans = orphanSandboxes(names, items.map(i => i.id));
      if (orphans.length) throw Error(`not in the panel list (inspect or delete them first): ${orphans.join(', ')}`);
      const accounted = items.filter(i => i.status === 'ready').length;
      return { detail: `${names.length} container(s); ${accounted} accounted sandbox(es) in the panel list` };
    });
    return results;
  };

  const ensureWritable = () => { try { mkdirSync(resolve(root, '.local'), { recursive: true }); accessSync(resolve(root, '.local'), constants.W_OK); return { ok: true, detail: '.local/evidence/raw/ is created per execution under a writable .local/' }; } catch (e) { return { ok: false, detail: `.local is not writable: ${e.message}` }; } };

  return {
    root, dirs, print, onUpdate: null,
    catalog: () => loadCatalog(root), panel, sendTask, logLineCount, logBoundary, policyBoundary, assessExecution, runNode, systemChecks, bundleStatus,
    bundleBytes: captureId => folderBytes(folder(captureId)),
    readExecutionFile: captureId => readJson(resolve(folder(captureId), 'execution.json')),
    readText: rel => { try { return readFileSync(resolve(root, rel), 'utf8'); } catch { return null; } },
    fileExists: rel => existsSync(resolve(root, rel)),
    evidenceStatus: ensureWritable, historyStats,
    freeBytes: () => { const s = statfsSync(root); return s.bavail * s.bsize; },
    now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), rand: n => randomBytes(n).toString('hex'),
    pid: process.pid, pidAlive: alive, readyPolls: 160, pollMs: 5000, retryMs: 8000, stabilizeMs: 4000, stabilizePolls: 8,
  };
}
