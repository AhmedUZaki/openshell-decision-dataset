import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,readdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationManager,conversationAllowed,newConversationId } from '../tools/events-panel/conversations.mjs';

function manager(){const root=testTmp('openshell-research-test-');mkdirSync(join(root,'.local'));return {root,m:new ConversationManager({root,state:{linuxUser:'tester'},run:async()=>{throw Error('External execution is forbidden in this unit test');}})};}
test('only the dedicated main route is admitted',()=>{assert.equal(conversationAllowed('/chat/main'),true);for(const p of ['/chat/other','/chat/main?session=other','/','/chat/main/other'])assert.equal(conversationAllowed(p),false);});
test('generated names meet the 19-character sandbox limit, contain no user paths',()=>{for(let i=0;i<20;i++){const id=newConversationId();assert.match(id,/^conv-[a-f0-9]{10}$/);assert.ok(id.length<=19);}});
test('origins map to exact registered conversation sandboxes',()=>{const {root,m}=manager();try{m.items=[{id:'conv-a',status:'ready',port:19000},{id:'conv-b',status:'ready',port:19001}];assert.equal(m.context('http://127.0.0.1:19000').id,'conv-a');assert.equal(m.context('http://127.0.0.1:19001').id,'conv-b');assert.equal(m.context('http://127.0.0.1:19000.evil.test'),undefined);assert.equal(m.context('https://127.0.0.1:19000'),undefined);}finally{rmSync(root,{recursive:true});}});
test('identity changes stop event collection',async()=>{const {root,m}=manager();try{m.shell=async()=>JSON.stringify({id:'replacement'});await assert.rejects(m.events({id:'conv-a',sandboxId:'original'}),/identity changed/);}finally{rmSync(root,{recursive:true});}});
test('a second conversation prevents mixed evidence',async()=>{const {root,m}=manager();try{m.verify=async()=>({});m.sessionCount=async()=>[{key:'agent:main:other'}];m.shell=async()=>{throw Error('Logs must not be read');};const result=await m.events({id:'conv-a',sandboxId:'fixed'});assert.deepEqual(result.events,[]);assert.match(result.error,/More than one conversation/);}finally{rmSync(root,{recursive:true});}});
test('events come only from the selected sandbox and do not claim per-tool truth',async()=>{const {root,m}=manager();try{m.verify=async()=>({});m.sessionCount=async()=>[];m.shell=async args=>{assert.equal(args[1],'conv-b');return '[1793570000.100] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED example.test:443';};const result=await m.events({id:'conv-b',sandboxId:'immutable-b'});assert.equal(result.events[0].sandboxId,'immutable-b');assert.equal(result.events[0].task_id,'conv-b');assert.equal(result.events[0].backgroundPossible,true);}finally{rmSync(root,{recursive:true});}});
test('policy history stores every listed revision and rejects mismatched snapshots',async()=>{const {root,m}=manager();try{const full={1:{hash:'9b27'+'0'.repeat(60),created_at_ms:1,loaded_at_ms:2,policy:{}},2:{hash:'8b2a'+'0'.repeat(60),created_at_ms:3,loaded_at_ms:4,policy:{}}};m.shell=async args=>args[1]==='list'?'VERSION  HASH  STATUS  CREATED  ERROR\n2  8b2a  Loaded  3\n1  9b27  Superseded  1\n':JSON.stringify(full[args[4]]);const h=await m.policyHistory({id:'conv-a'});assert.deepEqual(h.versions.map(v=>[v.version,v.loaded_at_ms]),[[1,2],[2,4]]);assert.deepEqual(h.policies[2],full[2]);full[1].hash='ffff';await assert.rejects(m.policyHistory({id:'conv-a'}),/does not match/);}finally{rmSync(root,{recursive:true});}});
test('saved bundles list their tool calls, scoped to the conversation sandbox when asked',()=>{const {root,m}=manager();try{
  const bundle=(id,task,files)=>{const dir=join(root,'.local','task-captures',id);mkdirSync(join(dir,'trajectory'),{recursive:true});for(const [name,content] of Object.entries(files))writeFileSync(join(dir,name),content);writeFileSync(join(dir,'manifest.json'),JSON.stringify({task_id:task,saved_at:`2026-11-01T1${id.at(-1)}:00:00Z`}));writeFileSync(join(dir,'task.json'),JSON.stringify({title:`T ${task}`}));};
  const record={sequence:1,requested_at:'2026-11-01T10:00:00Z',tool:{name:'write',domain:'filesystem',arguments:{path:'/usr/x'}},policy:{version:2},openshell:{decision:'DENY',source:'derived_from_static_policy',rule:{kind:'filesystem',section:'read_only',entry:'/usr'},note:null},result:{status:'error'},evidence_consistency:'consistent',openclaw_response:null};
  bundle('capture-'+'a'.repeat(23)+'1','conv-a',{'tool-calls.jsonl':JSON.stringify(record)+'\n','conversation.json':JSON.stringify({policy_versions:[{version:1},{version:2}]})});
  mkdirSync(join(root,'.local','task-captures','../escape'),{recursive:true});
  const all=m.captures();assert.deepEqual(all.map(c=>[c.taskId,c.policyVersions]),[['conv-a',[1,2]]]);
  assert.deepEqual([all[0].toolCalls[0].decision,all[0].toolCalls[0].rule],['DENY','read_only: /usr']);
  assert.deepEqual(m.captures('conv-a').map(c=>c.taskId),['conv-a']);
}finally{rmSync(root,{recursive:true});}});
test('deleting destroys only the named conversation sandbox, keeps bundles by default and refuses unsafe targets',async()=>{const {root,m}=manager();try{
  const a='conv-aaaaaaaaaa',b='conv-bbbbbbbbbb';
  const bundle=(captureId,task)=>{const dir=join(root,'.local','task-captures',captureId);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'manifest.json'),JSON.stringify({task_id:task}));};
  bundle('capture-'+'1'.repeat(24),a);bundle('capture-'+'2'.repeat(24),b);
  const reset=()=>{m.items=[{id:a,status:'ready',sandboxId:'sa',port:19000},{id:b,status:'ready',sandboxId:'sb',port:19001},{id:'conv-cccccccccc',status:'creating',port:19002}];writeFileSync(join(root,'.local',`${a}-panel.js`),'x');};
  let live=[a,b],nemoCalls=[];
  m.shell=async args=>args[0]==='sandbox'&&args[1]==='list'?'NAME  CREATED  PHASE\n'+live.map(n=>`\x1b[1m${n}\x1b[0m  2026  Ready`).join('\n')+'\n':'{}';
  m.verify=async item=>{if(item.sandboxId!=='sa')throw Error('Sandbox identity changed. Evidence collection stopped.');return {};};
  m.nemo=async args=>{nemoCalls.push(args);live=live.filter(n=>n!==args[0]);return '';};
  reset();
  for(const bad of ['my-assistant','conv-aaaaaaaaaa;rm','../conv-aaaaaaaaaa'])await assert.rejects(m.remove(bad),/Only conversations/);
  await assert.rejects(m.remove('conv-dddddddddd'),/Unknown conversation/);
  await assert.rejects(m.remove('conv-cccccccccc'),/creation finishes/);
  await assert.rejects(m.remove(a,{currentId:a}),/main OpenShell panel/);
  assert.equal(nemoCalls.length,0);
  const kept=await m.remove(a);
  assert.deepEqual(nemoCalls,[[a,'destroy','--yes','--no-cleanup-gateway','--keep-vllm']]);
  assert.deepEqual(m.items.map(i=>i.id),[b,'conv-cccccccccc']);
  assert.deepEqual([kept.removed,kept.bundlesDeleted,kept.bundlesKept],[a,0,1]);
  assert.equal(m.bundleFolders(a).length,1);assert.equal(live.includes(b),true);
  assert.equal(JSON.parse(readFileSync(m.file,'utf8')).some(i=>i.id===a),false);
  reset();live=[a,b];m.items[0].sandboxId='wrong';
  await assert.rejects(m.remove(a),/identity changed/);assert.equal(live.includes(a),true);assert.equal(m.items.some(i=>i.id===a),true);
  m.items[0].sandboxId='sa';const purged=await m.remove(a,{deleteBundles:true});
  assert.deepEqual([purged.bundlesDeleted,m.bundleFolders(a).length,m.bundleFolders(b).length],[1,0,1]);
  m.items=[{id:a,status:'failed',port:19000}];live=[];nemoCalls=[];
  assert.equal((await m.remove(a)).removed,a);assert.equal(nemoCalls.length,0,'nothing to destroy when the sandbox never existed');
  const legacy='conv-6f3d53b9c394';m.items=[{id:legacy,status:'failed',port:19000}];
  assert.equal((await m.remove(legacy)).removed,legacy,'12-character ids from before the name-length fix');
  await assert.rejects(m.remove('conv-6f3d53b9c3940'),/Only conversations/);
  live=[a];m.items=[{id:a,status:'ready',sandboxId:'sa',port:19000}];m.nemo=async()=>'';
  await assert.rejects(m.remove(a),/still present/);assert.equal(m.items.length,1,'record kept when destruction is unconfirmed');
}finally{rmSync(root,{recursive:true});}});
test('a run that ended in failure is finished and exportable; a running or unknown one is not',async()=>{const {root,m}=manager();try{m.items=[{id:'conv-a',sessionKey:'agent:main:main',sandboxId:'fixed'}];m.verify=async()=>({});m.shell=async()=>{throw Error('export reached');};
  for(const status of ['running','unknown',undefined]){m.sessions=async()=>[{key:'agent:main:main',status}];await assert.rejects(m.save('conv-a'),/still active/,String(status));}
  for(const status of ['done','failed']){m.sessions=async()=>[{key:'agent:main:main',status}];await assert.rejects(m.save('conv-a'),/export reached/,status);}
}finally{rmSync(root,{recursive:true});}});
test('saving an active or missing task is rejected before export',async()=>{const {root,m}=manager();try{m.items=[{id:'conv-a',sessionKey:'agent:main:main',sandboxId:'fixed'}];m.verify=async()=>({});m.sessions=async()=>[];await assert.rejects(m.save('conv-a'),/Send a task/);m.sessions=async()=>[{key:'agent:main:main',status:'running'}];await assert.rejects(m.save('conv-a'),/still active/);}finally{rmSync(root,{recursive:true});}});
test('closing saves first and stops the sandbox only after a successful save',async()=>{const {root,m}=manager();try{
  const a='conv-aaaaaaaaaa';const calls=[];
  m.items=[{id:a,status:'ready',sandboxId:'sa',port:19000}];
  m.verify=async()=>({});m.nemo=async args=>{calls.push(args.join(' '));return '';};
  for(const bad of ['my-assistant','conv-aaaaaaaaaa;rm'])await assert.rejects(m.close(bad),/Only conversations/);
  m.save=async()=>{throw Error('The task is still active or its completion is unconfirmed.');};
  await assert.rejects(m.close(a),/still active/);assert.equal(calls.length,0,'not stopped when the save failed');assert.equal(m.items[0].closedAt,undefined);
  m.save=async()=>({captureId:'capture-x',eventCount:3,toolCallCount:1});
  const result=await m.close(a);assert.equal(result.closed,a);assert.deepEqual(calls,[`${a} stop`]);assert.ok(m.items[0].closedAt);assert.ok(m.list()[0].closedAt);
  calls.length=0;m.nemo=async args=>{calls.push(args.join(' '));return 'http://127.0.0.1:19000/#token=t';};m.install=async()=>({});
  await m.open(a);assert.equal(calls[0],`${a} start`,'reopening starts the stopped sandbox first');assert.equal(m.items[0].closedAt,undefined);
}finally{rmSync(root,{recursive:true});}});
test('extra Balanced presets come from pins.env and only plain names are accepted',()=>{const {root,m}=manager();try{assert.deepEqual(m.extraPresets(),[]);mkdirSync(join(root,'setup'));writeFileSync(join(root,'setup','pins.env'),'MODEL=x\nPOLICY_EXTRA_PRESETS=brave, tavily ,bad name;rm,../x\n');assert.deepEqual(m.extraPresets(),['brave','tavily']);}finally{rmSync(root,{recursive:true});}});
test('environment record carries the pins, versions and model digest and tolerates missing tools',async()=>{const {root,m}=manager();try{mkdirSync(join(root,'setup'));writeFileSync(join(root,'setup','pins.env'),'MODEL=qwen2.5:1.5b\nOLLAMA_VERSION=0.40.13\nPOLICY_TIER=balanced\nPOLICY_EXTRA_PRESETS=brave\n');m.run=async(cmd,args)=>{const a=args.join(' ');if(a.endsWith('ollama list'))return {stdout:'NAME ID SIZE MODIFIED\nqwen2.5:1.5b    65ec06548149    986 MB    1 day ago\n'};if(a.endsWith('ollama --version'))return {stdout:'ollama version is 0.40.13'};if(a.includes('nemoclaw'))return {stdout:'nemoclaw v0.0.140'};throw Error('unexpected '+a);};const env=await m.environment({model:'qwen2.5:1.5b'},{openshellVersion:'openshell 0.0.116',openclawVersion:'OpenClaw 2026.9.2 (abc)',policyHash:'h1'});assert.equal(env.model.ollama_id,'65ec06548149');assert.deepEqual(env.versions,{openshell:'0.0.116',openclaw:'2026.9.2',nemoclaw:'0.0.140',ollama:'0.40.13'});assert.equal(env.pins.MODEL,'qwen2.5:1.5b');assert.match(env.pins_sha256,/^[a-f0-9]{64}$/);assert.equal(env.policy_hash,'h1');assert.deepEqual(env.policy,{profile:'balanced',label:'Balanced (default)',extra_presets:['brave'],presets_applied:[],revision:null,hash:'h1'});
  const restricted=await m.environment({model:'qwen2.5:1.5b',policyTier:'restricted'},{openshellVersion:'',openclawVersion:'',policyHash:'h2'});
  assert.deepEqual([restricted.policy.profile,restricted.policy.label,restricted.policy.extra_presets],['restricted','Restricted',[]],'a conversation records the tier it was created with, not only the pinned default');
  m.run=async(cmd,args)=>({stdout:args.join(' ').includes('policy list')?'  Policy presets for sandbox x:\n    ● brave [from openclaw agent] — Brave Search API access\n    ○ tavily — Tavily web search API access (opt-in)\n    ● npm [user-added] — npm and Yarn registry access\n':'x'});
  assert.deepEqual((await m.environment({id:'conv-0123456789',model:'x'},{openshellVersion:'',openclawVersion:'',policyHash:'h3'})).policy.presets_applied,['brave','npm'],'only presets NemoClaw lists as applied');m.run=async()=>{throw Error('down');};const bare=await m.environment({model:'x'},{openshellVersion:'',openclawVersion:'',policyHash:null});assert.equal(bare.model.ollama_id,null);assert.equal(bare.versions.ollama,null);}finally{rmSync(root,{recursive:true});}});

test('a conversation is created with the policy tier it asks for, and the Balanced extras apply to Balanced only',async()=>{
  const make=async(request)=>{const {root,m}=manager();mkdirSync(join(root,'setup'));writeFileSync(join(root,'setup','pins.env'),'POLICY_TIER=balanced\nPOLICY_EXTRA_PRESETS=brave\n');
    const calls=[];m.nemo=async(args,extra=[])=>{calls.push({args,extra});return 'creation log';};
    m.shell=async args=>args[0]==='sandbox'?JSON.stringify({id:'4fdb7d21-17d5-4d4b-87f3-37f38d28b7bc'}):JSON.stringify({version:3,hash:'h'});m.install=async()=>({});
    m.taskRefFor=()=>({task_source:'task_catalog',task_id:'fetch-test-task',task_version:1,task_hash:'h',category:'single-action-policy-tests',title:'t',task:'run it'});
    const started=m.create({title:'t',task:'run it',...request});
    for(let i=0;i<50&&m.items[0].status==='creating';i++)await new Promise(r=>setTimeout(r,5));
    return {root,m,calls,started};};
  const cleanup=({root})=>rmSync(root,{recursive:true});
  const def=await make({});
  try{assert.equal(def.m.items[0].status,'ready');assert.ok(def.calls[0].extra.includes('NEMOCLAW_POLICY_TIER=balanced'));assert.ok(def.calls.some(c=>c.args.join(' ')==='research-'+def.m.items[0].id.slice(9)+' policy add brave --yes'||c.args.slice(1).join(' ')==='policy add brave --yes'),'Balanced gets its extra preset');assert.equal(def.m.items[0].policyTier,'balanced');}finally{cleanup(def);}
  const open=await make({policyTier:'Open',plan:{id:'host-pypi-org-open',family:'host:pypi.org',group:'host',wave:2}});
  try{assert.ok(open.calls[0].extra.includes('NEMOCLAW_POLICY_TIER=open'));assert.equal(open.calls.some(c=>c.args.includes('add')),false,'other tiers are left as NemoClaw makes them');assert.deepEqual([open.m.items[0].policyTier,open.m.items[0].plan],['open',{id:'host-pypi-org-open',family:'host:pypi.org',group:'host',wave:2}]);assert.equal(open.m.list()[0].policyTier,'open');}finally{cleanup(open);}
  const {root,m}=manager();try{
    for(const bad of ['personal','strict','','x;rm'])if(bad!=='')assert.throws(()=>m.tierFor(bad),/restricted, balanced or open/);
    assert.equal(m.tierFor(undefined),'balanced');assert.equal(m.tierFor(' RESTRICTED '),'restricted');
    assert.throws(()=>m.planFor('x'),/plan must be an object/);assert.throws(()=>m.planFor({family:'a b'}),/plan.family/);assert.throws(()=>m.planFor({wave:1.5}),/plan.wave/);assert.throws(()=>m.planFor({id:'../x'}),/plan.id/);
    assert.deepEqual(m.planFor({id:'a',family:'f:1',group:'g',wave:3,extra:'dropped'}),{id:'a',family:'f:1',group:'g',wave:3});assert.equal(m.planFor(undefined),null);
  }finally{rmSync(root,{recursive:true});}
});

// ---- new conversations: catalog tasks and custom manual tasks, autonomous only ------------------------------------------------------
import { bundleEvidence } from '../tools/events-panel/provenance.mjs';
function configuredManager() {
  const ctx = manager();
  mkdirSync(join(ctx.root, 'safety-router-dataset'), { recursive: true }); mkdirSync(join(ctx.root, 'setup'), { recursive: true });
  writeFileSync(join(ctx.root, 'setup', 'pins.env'), 'MODEL=qwen2.5:1.5b\nCONTEXT_WINDOW=32768\nMAX_TOKENS=2048\nNEMOCLAW_VERSION=0.0.140\n');
  return ctx;
}
// ---- new conversations: catalog tasks and custom manual tasks, autonomous only ------------------------------------------------------
import { loadCatalog } from '../safety-router-dataset/collect-data/task-catalog.mjs';
import { testTmp } from './tmp-dir.mjs';
const catalogTask = (over = {}) => ({ schema_version: 1, task_id: 'read-a-page', version: 1, title: 'Read a page', description: 'Reads one public page and summarizes it.', category: 'web-research', task_text: 'Read the page at https://pypi.org/simple/ and write a short summary of it.', tags: ['network'], expected_capabilities: ['network'], external_dependency: 'live_external', estimated_minutes: 3, enabled: true, deprecated: false, safety_notes: [], ...over });
function catalogManager(tasks = { 'read-a-page.json': catalogTask() }) {
  const ctx = configuredManager();
  const dir = join(ctx.root, 'safety-router-dataset', 'task-catalog');
  mkdirSync(join(dir, 'web-research'), { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ schema_version: 1, categories: [{ id: 'web-research', title: 'Web research', description: '', order: 1 }], registry: {} }));
  for (const [name, task] of Object.entries(tasks)) writeFileSync(join(dir, 'web-research', name), JSON.stringify(task));
  ctx.put = (name, task) => writeFileSync(join(dir, 'web-research', name), JSON.stringify(task));
  return ctx;
}
const stubCreation = m => { m.nemo = async () => ''; m.install = async () => ({}); m.shell = async args => args[0] === 'sandbox' ? JSON.stringify({ id: '11111111-1111-1111-1111-111111111111' }) : JSON.stringify({ version: 1, hash: 'h' }); };
test('only autonomous conversations can be created; fixed-action and unknown modes are refused', () => {
  const { root, m } = catalogManager();
  try {
    const base = { taskSource: 'task_catalog', taskId: 'read-a-page', policyTier: 'restricted' };
    for (const mode of ['controlled_action', 'both', 'x']) assert.throws(() => m.create({ ...base, experimentMode: mode }), /Only autonomous Agent conversations/);
    assert.equal(m.items.length, 0, 'nothing was registered by the refused requests');
  } finally { rmSync(root, { recursive: true }); }
});
test("a catalog task is read from the catalog by id: the text, version and hash are the catalog's, never the browser's", async () => {
  const { root, m, put } = catalogManager({ 'read-a-page.json': catalogTask(), 'disabled.json': catalogTask({ task_id: 'disabled-task', enabled: false }), 'old.json': catalogTask({ task_id: 'old-task', deprecated: true }) });
  try {
    stubCreation(m);
    const bad = [[{ taskSource: 'task_catalog', taskId: 'nope-task' }, /not an enabled task of the catalog/], [{ taskSource: 'task_catalog', taskId: 'disabled-task' }, /not an enabled task/], [{ taskSource: 'task_catalog', taskId: 'old-task' }, /not an enabled task/],
      [{ taskSource: 'task_catalog' }, /not an enabled task/], [{ taskSource: 'task_catalog', taskId: '../../etc/passwd' }, /not an enabled task/], [{ taskSource: 'other', taskId: 'read-a-page' }, /taskSource must be/],
      [{ taskSource: 'task_catalog', taskId: 'read-a-page', expect: { version: 1, hash: 'f'.repeat(64) } }, /changed since it was selected/], [{ taskSource: 'task_catalog', taskId: 'read-a-page', execution: { run_id: 'run-x', execution_id: 'x', separate_run: 1 } }, /execution\./]];
    for (const [req, message] of bad) assert.throws(() => m.create({ policyTier: 'open', ...req }), message, JSON.stringify(req).slice(0, 60));
    assert.equal(m.items.length, 0);
    const cat = loadCatalog(root).tasks.find(x => x.task_id === 'read-a-page');
    const created = m.create({ taskSource: 'task_catalog', taskId: 'read-a-page', task: 'IGNORED browser text', title: 'My title', policyTier: 'open', expect: { version: 1, hash: cat.hash } });
    await new Promise(r => setTimeout(r, 30));
    const item = m.items.find(i => i.id === created.id);
    assert.equal(item.task, cat.task_text, 'the catalog text, not the text the browser sent');
    assert.deepEqual([item.taskRef.task_source, item.taskRef.task_id, item.taskRef.task_version, item.taskRef.task_hash, item.taskRef.category, item.experimentMode, item.policyTier, item.status], ['task_catalog', 'read-a-page', 1, cat.hash, 'web-research', 'autonomous_agent', 'open', 'ready']);
    assert.deepEqual([m.list().find(i => i.id === created.id).taskSource, m.list().find(i => i.id === created.id).taskId], ['task_catalog', 'read-a-page']);
    // editing the task file changes what a new conversation records
    put('read-a-page.json', catalogTask({ version: 2, task_text: 'Read the page at https://pypi.org/simple/requests/ and write a short summary of it.' }));
    m.busy = false;
    const again = m.create({ taskSource: 'task_catalog', taskId: 'read-a-page', policyTier: 'open' });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(m.items.find(i => i.id === again.id).taskRef.task_version, 2);
    assert.match(m.items.find(i => i.id === again.id).task, /simple\/requests/);
  } finally { rmSync(root, { recursive: true }); }
});
test('a custom manual task can no longer be created: only a Single-Action Policy Test from the catalog', async () => {
  const { root, m } = catalogManager();
  try {
    stubCreation(m);
    const before = readFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), 'utf8');
    for (const request of [{ taskSource: 'custom_manual', title: 'x', task: 'do it', policyTier: 'open' }, { title: 'My manual test', task: 'Tell me a joke.', policyTier: 'restricted' }, { taskSource: 'custom_manual', title: 'x', task: 'do it', taskId: 'read-a-page', policyTier: 'open' }])
      assert.throws(() => m.create(request), /Only a Single-Action Policy Test from the task catalog/);
    assert.equal(m.items.length, 0, 'nothing was registered');
    assert.equal(readFileSync(join(root, 'safety-router-dataset/task-catalog/catalog.json'), 'utf8'), before);
  } finally { rmSync(root, { recursive: true }); }
});
test('collection identifiers are validated, and an execution never gets a second environment', async () => {
  const { root, m } = catalogManager();
  try {
    stubCreation(m);
    const good = { run_id: 'run-20261103T101500-abcd', execution_id: 'run-20261103T101500-abcd-e00001', separate_run: 1 };
    const base = { taskSource: 'task_catalog', taskId: 'read-a-page', policyTier: 'open' };
    for (const execution of [{ ...good, run_id: '../x' }, { ...good, execution_id: 'run-20261103T101500-abcd-e1' }, { ...good, execution_id: 'run-20261103T101500-ffff-e00001' }, { ...good, separate_run: 0 }, { ...good, separate_run: 21 }, { ...good, separate_run: '1' }, 'x', []]) assert.throws(() => m.create({ ...base, execution }), /execution/, JSON.stringify(execution));
    const created = m.create({ ...base, execution: good });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(m.items.find(i => i.id === created.id).execution.execution_id, good.execution_id);
    m.busy = false;
    assert.throws(() => m.create({ ...base, execution: good }), /already exists; every execution gets its own/);
  } finally { rmSync(root, { recursive: true }); }
});

// A save of an autonomous conversation with a mocked sandbox: it writes the bundle, the raw and sanitized layers and execution.json.
async function savedBundle({ execution = null, source = 'task_catalog', log = null } = {}) {
  const { root, m } = catalogManager();
  const id = 'conv-aaaaaaaaaa', sandboxId = '11111111-1111-1111-1111-111111111111';
  const cat = loadCatalog(root).tasks[0];
  const t0 = Date.parse('2026-11-02T10:00:10.000Z'), sec = ms => ((t0 + ms) / 1000).toFixed(3);
  const text = log ?? [`[${sec(100)}] [sandbox] [OCSF ] [ocsf] CONFIG:LOADED [INFO] policy loaded`, `[${sec(400)}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(2300) -> pypi.org:443 [policy:- engine:opa] [reason:endpoint pypi.org:443 is not allowed by any policy]`, `[${sec(500)}] [sandbox] [INFO ] [proxy] Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`].join('\n') + '\n';
  const policy = { version: 1, filesystem_policy: { read_only: ['/usr'], read_write: ['/tmp'] }, landlock: { compatibility: 'best_effort' }, process: {}, network_policies: { clawhub: { endpoints: [{ host: 'clawhub.ai' }] } } };
  const taskRef = source === 'task_catalog' ? { task_source: 'task_catalog', task_id: cat.task_id, task_version: cat.version, task_hash: cat.hash, category: cat.category } : { task_source: 'custom_manual', task_id: null, task_version: null, task_hash: null, category: null };
  m.items = [{ id, title: 'T', task: 'Read the page at https://pypi.org/simple/ now.', status: 'ready', sandboxId, port: 19000, model: 'qwen2.5:1.5b', sessionKey: 'agent:main:main', policyTier: 'restricted', experimentMode: 'autonomous_agent', action: null, createdAt: '2026-11-02T10:00:00.000Z',
    plan: null, execution, taskRef, initialPolicy: { version: 1, hash: 'h-initial' } }];
  const call = [{ seq: 1, type: 'tool.call', ts: '2026-11-02T10:00:10.200Z', sessionId: 's1', data: { toolCallId: 'c1', name: 'exec', arguments: { command: 'curl -sS https://pypi.org/simple/' } } }, { seq: 2, type: 'tool.result', ts: '2026-11-02T10:00:10.900Z', sessionId: 's1', data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'curl: (56) CONNECT tunnel failed\n\n(Command exited with code 56)' }] } } }].map(e => JSON.stringify(e)).join('\n') + '\n';
  m.verify = async () => ({});
  m.sessions = async () => [{ key: 'agent:main:main', status: 'done', sessionId: 's1', updatedAt: 1 }];
  m.nemo = async args => args.includes('--version') ? 'nemoclaw 0.0.140' : '';
  m.install = async () => ({ docker: 'docker', container: 'c' });
  m.shell = async args => {
    if (args[0] === '--version') return 'openshell 0.0.116';
    if (args[0] === 'logs') return text;
    if (args[0] === 'sandbox' && args[1] === 'exec' && args.includes('export-trajectory')) return JSON.stringify({ sessionId: 's1', outputDir: `/sandbox/.openclaw/trajectory-exports/${args[args.indexOf('--output') + 1]}`, files: ['events.jsonl'] });
    if (args[0] === 'sandbox' && args[1] === 'exec') return 'OpenClaw 2026.9.2';
    if (args[0] === 'policy' && args[1] === 'list') return 'VERSION  HASH  STATUS  CREATED  ERROR\n1  abcd  Loaded  1\n';
    if (args[0] === 'policy' && args.includes('--rev')) return JSON.stringify({ version: 1, hash: 'abcd' + '0'.repeat(60), created_at_ms: 1, loaded_at_ms: 1, policy });
    if (args[0] === 'policy' && args[1] === 'get') return JSON.stringify({ version: 1, hash: 'eff-hash', policy });
    throw Error(`unexpected shell call ${args.join(' ')}`);
  };
  m.run = async (cmd, args) => {
    if (args.includes('cp')) { const target = args.at(-1); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'events.jsonl'), call); return { stdout: '', stderr: '' }; }
    throw Error('not available');
  };
  const saved = await m.save(id);
  return { root, m, saved, cat, text };
}
test('saving a catalog execution keeps every OpenShell line in a raw layer, derives a sanitized layer, and records the identifiers together', async () => {
  const execution = { run_id: 'run-20261103T101500-abcd', execution_id: 'run-20261103T101500-abcd-e00007', separate_run: 2 };
  const { root, saved, cat, text } = await savedBundle({ execution });
  try {
    assert.equal(saved.experimentMode, 'autonomous_agent');
    const rawDir = join(root, '.local/evidence/raw', execution.run_id, execution.execution_id), sanDir = join(root, '.local/evidence/sanitized', execution.run_id, execution.execution_id);
    assert.equal(readFileSync(join(rawDir, 'openshell-sandbox.log'), 'utf8'), text, 'the raw layer is the log exactly as received');
    assert.match(readFileSync(join(rawDir, 'openshell-sandbox.log'), 'utf8'), /Bearer abcdefghij/);
    const sanitized = readFileSync(join(sanDir, 'openshell-sandbox.sanitized.log'), 'utf8');
    assert.doesNotMatch(sanitized, /abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.equal(readFileSync(join(saved.folder, 'openshell-log-sanitized.txt'), 'utf8'), sanitized, 'the bundle log is the sanitized layer');
    assert.equal(readdirSync(rawDir).length, 4);
    const doc = JSON.parse(readFileSync(join(saved.folder, 'execution.json'), 'utf8'));
    assert.deepEqual([doc.collection_run_id, doc.execution_id, doc.task_source, doc.task_id, doc.task_version, doc.task_hash, doc.category, doc.policy, doc.separate_run, doc.conversation_id, doc.sandbox_id, doc.capture_id, doc.experiment_mode, doc.experiment_mode_source],
      [execution.run_id, execution.execution_id, 'task_catalog', 'read-a-page', 1, cat.hash, 'web-research', 'restricted', 2, 'conv-aaaaaaaaaa', '11111111-1111-1111-1111-111111111111', saved.captureId, 'autonomous_agent', 'recorded']);
    assert.deepEqual([doc.evidence.raw_dir, doc.evidence.sanitized_dir], [`.local/evidence/raw/${execution.run_id}/${execution.execution_id}`, `.local/evidence/sanitized/${execution.run_id}/${execution.execution_id}`]);
    assert.equal(saved.evidence.raw.counts.total, 3);
    assert.equal(bundleEvidence(saved.folder).complete, true);
    const task = JSON.parse(readFileSync(join(saved.folder, 'task.json'), 'utf8'));
    assert.deepEqual([task.task_source, task.catalog_task_id, task.task_version, task.task_hash, task.category, task.experiment_mode], ['task_catalog', 'read-a-page', 1, cat.hash, 'web-research', 'autonomous_agent']);
    const manifest = JSON.parse(readFileSync(join(saved.folder, 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.experiment_mode, manifest.execution], ['autonomous_agent', 'execution.json']);
    // a bundle whose evidence layer disappears is no longer complete
    rmSync(join(rawDir, '..'), { recursive: true, force: true });
    assert.equal(bundleEvidence(saved.folder).complete, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a manual GUI save records custom_manual or the catalog task, in a separate manual evidence folder', async () => {
  const custom = await savedBundle({ source: 'custom_manual' });
  try {
    const doc = JSON.parse(readFileSync(join(custom.saved.folder, 'execution.json'), 'utf8'));
    assert.deepEqual([doc.collection_run_id, doc.execution_id, doc.task_source, doc.task_id, doc.separate_run], [null, null, 'custom_manual', null, null]);
    assert.equal(doc.evidence.run_id, 'manual');
    assert.match(doc.evidence.raw_dir, /^\.local\/evidence\/raw\/manual\/manual-capture-[a-f0-9]{24}$/);
    assert.equal(JSON.parse(readFileSync(join(custom.saved.folder, 'task.json'), 'utf8')).task_source, 'custom_manual');
    assert.equal(bundleEvidence(custom.saved.folder).complete, true);
  } finally { rmSync(custom.root, { recursive: true, force: true }); }
  const cat = await savedBundle({ source: 'task_catalog' });
  try {
    const doc = JSON.parse(readFileSync(join(cat.saved.folder, 'execution.json'), 'utf8'));
    assert.deepEqual([doc.task_source, doc.task_id, doc.task_version, doc.collection_run_id], ['task_catalog', 'read-a-page', 1, null]);
  } finally { rmSync(cat.root, { recursive: true, force: true }); }
});
