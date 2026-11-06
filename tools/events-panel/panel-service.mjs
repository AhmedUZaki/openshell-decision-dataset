import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual, createHash } from 'node:crypto';
import { parseEvent } from './openshell-events.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConversationManager, conversationAllowed } from './conversations.mjs';
import { loadCatalog, byCategory } from '../../safety-router-dataset/collect-data/task-catalog.mjs';
import { buildRecord } from './single-action-record.mjs';
import { liveExportCommands, buildActivity, parseSessions, pickSession } from './live-session.mjs';
import { TIER_NAMES, TIER_LABELS, parseTiers, parsePresetList, currentTier, planSwitch, editBlock } from './policy-tier.mjs';
import { appendFileSync } from 'node:fs';

const runFile = promisify(execFile);
const run = (...args) => {
  const pending = runFile(...args);
  pending.child?.stdin?.end();
  return pending;
};
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
// Identifies the code this process loaded: the files listed in service-files.txt, in that order. Enable-Panel.ps1
// computes the same hash from the same list and restarts the service when it differs, so no version bump is needed.
const serviceFiles = readFileSync(resolve(here, 'service-files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const build = createHash('sha256').update(Buffer.concat(serviceFiles.map(name => readFileSync(resolve(here, name))))).digest('hex');
const statePath = resolve(root, '.local/openshell-panel-state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(state.linuxUser) || !/^[a-f0-9]{64}$/.test(state.capability)) throw Error('Invalid local panel configuration');
const origin = 'http://127.0.0.1:18789';
const context = new AsyncLocalStorage();
const conversations = new ConversationManager({root,state,run});
const sandboxName = () => context.getStore()?.sandbox || 'my-assistant';
let snapshot = { events: [], updatedAt: null, error: null, sandbox: 'my-assistant' };
let lastRead = 0;
let pending = null;
async function cli(args) {
  args = args.map(value => value === 'my-assistant' ? sandboxName() : value);
  const result = await run('wsl.exe', ['-d','Ubuntu-24.04','--',`/home/${state.linuxUser}/.local/bin/openshell`, ...args], {timeout:75000,maxBuffer:2*1024*1024,windowsHide:true});
  return result.stdout;
}
async function policy() {
  return JSON.parse(await cli(['policy','get','my-assistant','--full','--output','json']));
}
// ---- Policy tier of this chat's sandbox: read, and switch between NemoClaw's own tiers (never in a dataset collection sandbox) ----
let tierBusy = false;
async function tierState(conversation) {
  const sandbox = sandboxName();
  const tiersText = (await run('wsl.exe', ['-d','Ubuntu-24.04','--','cat',`/home/${state.linuxUser}/.nemoclaw/source/nemoclaw-blueprint/policies/tiers.yaml`], {timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout;
  const tiers = parseTiers(tiersText);
  const list = parsePresetList(await conversations.nemo([sandbox,'policy','list'],[],120000));
  const blocked = editBlock(conversation);
  return { sandbox, tiers, labels: TIER_LABELS, current: currentTier(tiers, list.applied), list, editable: !blocked, reason: blocked };
}
async function setTier(conversation, request) {
  if (request.confirm !== true) throw Error('Switching the policy tier needs confirmation.');
  if (!TIER_NAMES.includes(request.tier)) throw Error('The tier must be restricted, balanced or open.');
  if (tierBusy) throw Error('A policy change is already running.');
  tierBusy = true;
  try {
    const s = await tierState(conversation);
    if (!s.editable) throw Error(s.reason);
    const plan = planSwitch(s.tiers, s.list, request.tier);
    const done = [];
    try {
      for (const preset of plan.add) { await conversations.nemo([s.sandbox,'policy','add',preset,'--yes'],[],300000); done.push(`add ${preset}`); }
      for (const preset of plan.remove) { await conversations.nemo([s.sandbox,'policy','remove',preset,'--yes'],[],300000); done.push(`remove ${preset}`); }
    } finally {
      // Whatever happened, the change is recorded, so a half-applied switch is never invisible.
      const entry = { at: new Date().toISOString(), sandbox: s.sandbox, from_tier: plan.from, to_tier: plan.to, added: plan.add, removed: plan.remove, completed: done };
      try { appendFileSync(resolve(root, '.local/policy-edits.jsonl'), JSON.stringify(entry) + '\n'); } catch {}
      if (conversation && done.length) conversations.noteTierChange(conversation, entry);
    }
    const after = await tierState(conversation);
    return { changed: plan.add.length + plan.remove.length > 0, from: plan.from, to: plan.to, added: plan.add, removed: plan.remove, current: after.current };
  } finally { tierBusy = false; }
}
const publicTierState = s => ({ sandbox: s.sandbox, labels: s.labels, tiers: s.tiers, current: s.current, applied: [...s.list.applied], editable: s.editable, reason: s.reason });
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Error('JSON content type is required.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16000) throw Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function safeError(error) {
  const message = String(error.stderr || error.message || 'Policy operation failed.');
  return message.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').slice(0,1800);
}

async function collect() {
  if (Date.now() - lastRead < 2500) return;
  if (pending) return pending;
  pending = (async () => {
    try {
      const { stdout } = await run('wsl.exe', ['-d', 'Ubuntu-24.04', '--', `/home/${state.linuxUser}/.local/bin/openshell`, 'logs', 'my-assistant', '--source', 'sandbox', '-n', '200'], { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true });
      const unique = new Map();
      for (const line of stdout.split(/\r?\n/)) { const event = parseEvent(line); if (event) unique.set(event.id, event); }
      snapshot = { events: [...unique.values()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 80), updatedAt: new Date().toISOString(), error: null, sandbox: 'my-assistant' };
    } catch {
      snapshot = { ...snapshot, error: 'OpenShell logs are unavailable. Check the sandbox and gateway.', updatedAt: new Date().toISOString() };
    } finally { lastRead = Date.now(); pending = null; }
  })();
  return pending;
}

// The live chat of the shared my-assistant sandbox, for the dashboard's OpenShell panel. Read-only: OpenClaw's own exporter writes a temporary
// folder inside the sandbox, which is removed again; nothing is saved on Windows. A session that has not changed is not exported again.
let activityCache = { key: null, updatedAt: null, trajectoryText: null };
let activityPending = null;
async function inSandbox(args, maxBuffer = 32 * 1024 * 1024) {
  const result = await run('wsl.exe', ['-d','Ubuntu-24.04','--',`/home/${state.linuxUser}/.local/bin/openshell`,'sandbox','exec','-n','my-assistant','--',...args], {timeout:90000,maxBuffer,windowsHide:true});
  return result.stdout;
}
async function agentActivity(requestedKey) {
  const sessions = parseSessions(await inSandbox(['openclaw','sessions','--json'], 8 * 1024 * 1024));
  const session = pickSession(sessions, requestedKey);
  const list = sessions.map(s => ({ key: s.key, status: s.status, updatedAt: s.updatedAt }));
  if (!session) return { sessions: list, session: null, items: [], counts: null, unreadable_lines: [] };
  if (activityCache.key !== session.key || activityCache.updatedAt !== session.updatedAt) {
    const commands = liveExportCommands(session.key);
    await inSandbox(commands.clear);
    let trajectoryText;
    try { await inSandbox(commands.export, 4 * 1024 * 1024); trajectoryText = await inSandbox(commands.read); }
    finally { await inSandbox(commands.clear).catch(() => {}); }
    activityCache = { key: session.key, updatedAt: session.updatedAt, trajectoryText };
  }
  const { stdout } = await run('wsl.exe', ['-d','Ubuntu-24.04','--',`/home/${state.linuxUser}/.local/bin/openshell`,'logs','my-assistant','--source','sandbox','-n','3000'], {timeout:30000,maxBuffer:16*1024*1024,windowsHide:true});
  const events = [...new Map(stdout.split(/\r?\n/).map(parseEvent).filter(Boolean).map(e => [e.id, e])).values()];
  return { sessions: list, session, ...buildActivity({ trajectoryText: activityCache.trajectoryText, events }), readAt: new Date().toISOString() };
}

const readRoutes = ['/events', '/health', '/policy', '/policy/tier', '/conversations/list', '/conversations/captures', '/catalog'];
const writeRoutes = ['/policy/tier/set', '/conversations/create', '/conversations/open', '/conversations/save', '/conversations/close', '/conversations/delete', '/conversations/timeline', '/agent/activity'];
// The task catalog and the live my-assistant chat are read-only and for the main panel only, never for a conversation's own page.
const mainOnlyRoutes = ['/catalog', '/agent/activity'];
const handleRequest = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== '127.0.0.1:18891') { res.writeHead(403).end(); return; }
  const requestOrigin = req.headers.origin;
  const validOrigin = requestOrigin === origin || Boolean(conversations.context(requestOrigin));
  if (requestOrigin && !validOrigin) { res.writeHead(403).end(); return; }
  if (validOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  if (!readRoutes.includes(req.url) && !writeRoutes.includes(req.url)) { res.writeHead(404).end(); return; }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'X-OpenShell-Panel, X-OpenShell-Conversation, Content-Type');
    res.writeHead(204).end(); return;
  }
  const isWrite = writeRoutes.includes(req.url);
  if (req.method !== (isWrite ? 'POST' : 'GET')) { res.writeHead(405).end(); return; }
  if (isWrite && !validOrigin) { res.writeHead(403).end(); return; }
  const provided = Buffer.from(String(req.headers['x-openshell-panel'] || ''));
  const expected = Buffer.from(state.capability);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url === '/health') { res.end(JSON.stringify({ ok: true, service: 'openshell-panel', build })); return; }
  try {
    if (mainOnlyRoutes.includes(req.url) && requestOrigin !== origin) throw Error('This is available from the main OpenShell panel only.');
    if(req.url==='/catalog'){
      // The selectable tasks of safety-router-dataset/task-catalog/, as files define them: nothing here is executed, and nothing outside that folder is read.
      const catalog=loadCatalog(root);
      res.end(JSON.stringify({ok:catalog.ok,errors:catalog.errors.slice(0,20),warnings:catalog.warnings.slice(0,20),categories:byCategory(catalog).map(c=>({id:c.id,title:c.title,description:c.description,tasks:c.tasks.map(x=>({task_id:x.task_id,title:x.title,description:x.description,task_text:x.task_text,version:x.version,hash:x.hash,tags:x.tags,expected_capabilities:x.expected_capabilities,task_type:x.task_type,single_action:x.single_action,external_dependency:x.external_dependency,estimated_minutes:x.estimated_minutes,safety_notes:x.safety_notes}))}))}));return;
    }
    if(req.url==='/agent/activity'){
      const request=await body(req);
      const key=request.sessionKey??null;
      if(key!==null&&typeof key!=='string')throw Error('sessionKey must be a string.');
      // One read at a time: a request for the same session shares the read in progress; one for another session waits for it, then reads its own.
      const wanted=key??'';
      if(!activityPending||activityPending.key!==wanted){
        const previous=activityPending?.promise.catch(()=>{});
        const promise=(async()=>{await previous;return agentActivity(key);})();
        activityPending={key:wanted,promise};
        promise.catch(()=>{}).finally(()=>{if(activityPending?.promise===promise)activityPending=null;});
      }
      res.end(JSON.stringify(await activityPending.promise));return;
    }
    const currentConversation = conversations.context(requestOrigin);
    if(currentConversation) await conversations.verify(currentConversation);
    if(req.url==='/conversations/list'){res.end(JSON.stringify({items:conversations.list(),current:currentConversation?.id||null}));return;}
    if(req.url==='/conversations/captures'){res.end(JSON.stringify({captures:conversations.captures(currentConversation?.id||null)}));return;}
    if(req.url==='/conversations/create'){res.end(JSON.stringify(conversations.create(await body(req))));return;}
    if(req.url==='/conversations/timeline'){
      // Read-only: the complete Agent and OpenShell timelines of one saved Bundle, built from the Bundle exactly as the Dataset exporter builds them.
      const request=await body(req);
      if(!/^capture-[a-f0-9]{24}$/.test(String(request.captureId)))throw Error('captureId is not valid.');
      const {record,category}=buildRecord(root,request.captureId);
      res.end(JSON.stringify({captureId:request.captureId,category,task:record.task,agent_timeline:record.agent_timeline,openshell_timeline:record.openshell_timeline,action_and_policy_events:{agent_action:record.action_and_policy_events.agent_action,observed:record.action_and_policy_events.events_observed_during_action.length,outside:record.action_and_policy_events.events_outside_action.length},policy_result:record.policy_result,execution_results:record.execution_results}));return;
    }
    if(req.url==='/conversations/open'){const request=await body(req);res.end(JSON.stringify(await conversations.open(request.id)));return;}
    if(req.url==='/conversations/delete'){
      const request=await body(req);
      // Allowed from the main panel for any conversation, or from inside a conversation for that conversation only.
      const self=Boolean(currentConversation)&&request.id===currentConversation.id;
      if(request.confirm!==true||(requestOrigin!==origin&&!self))throw Error('Deleting a conversation needs confirmation from the main panel or from the conversation itself.');
      res.end(JSON.stringify(await conversations.remove(request.id,{deleteBundles:request.deleteBundles===true})));return;
    }
    if(req.url==='/conversations/close'){
      const request=await body(req);
      if(!currentConversation||request.id!==currentConversation.id||request.confirm!==true||!conversationAllowed(req.headers['x-openshell-conversation']))throw Error('Close a conversation from inside its own main chat, after confirming.');
      res.end(JSON.stringify(await conversations.close(request.id)));return;
    }
    if(req.url==='/conversations/save'){
      const request=await body(req);
      if(!currentConversation||request.id!==currentConversation.id||!conversationAllowed(req.headers['x-openshell-conversation']))throw Error('Save evidence from the dedicated sandbox main conversation only.');
      res.end(JSON.stringify(await conversations.save(request.id)));return;
    }
    if(req.url==='/events'){
      // Shared sandbox: shown for monitoring only, never attributed to the open conversation.
      if(!currentConversation){await collect();res.end(JSON.stringify({...snapshot,events:snapshot.events.map(e=>({...e,correlation:'shared_sandbox'})),scope:'shared_sandbox',notice:'Sandbox-wide · all my-assistant conversations'}));return;}
      if(!conversationAllowed(req.headers['x-openshell-conversation'])){res.end(JSON.stringify({events:[],error:'This sandbox belongs to its main conversation only. Use a new isolated sandbox for a different chat.'}));return;}
      res.end(JSON.stringify(await conversations.events(currentConversation)));return;
    }
    if (req.url === '/policy') { res.end(JSON.stringify(await policy())); return; }
    if (req.url === '/policy/tier') { res.end(JSON.stringify(publicTierState(await tierState(currentConversation)))); return; }
    if (req.url === '/policy/tier/set') { res.end(JSON.stringify(await setTier(currentConversation, await body(req)))); return; }
  } catch(error) { res.writeHead(400); res.end(JSON.stringify({error:safeError(error)})); return; }
  await collect();
  res.end(JSON.stringify(snapshot));
};
const server = http.createServer((req,res)=>{
  const item=conversations.context(req.headers.origin);
  context.run({sandbox:item?.id||'my-assistant'},()=>{
    handleRequest(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Local service error. Check the conversation sandbox state.'}));});
  });
});
server.listen(18891, '127.0.0.1', () => {
  writeFileSync(resolve(root, '.local/openshell-panel.pid'), String(process.pid));
});
server.on('error', () => process.exit(1));
