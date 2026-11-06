import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parseEvent, redact, REASON_LIMIT } from './openshell-events.mjs';
import { buildToolCalls, conversationRecord, parsePolicyList, toolCallSummary } from './tool-calls.mjs';
import { policyLabel } from './policy-labels.mjs';
import { loadCatalog } from '../../safety-router-dataset/collect-data/task-catalog.mjs';
import { taskOutcome } from './tool-calls.mjs';
import { writeRawEvidence, writeSanitizedEvidence, LOG_LIMIT } from './evidence.mjs';
// Session states in which the Agent's run is over. Anything else (running, unknown) means the task is still active or its end is unconfirmed.
const FINISHED_RUN_STATUSES=['done','failed'];
import { PROTOCOL_VERSION, DEPENDENCY_MODES, reproducibilityDeclaration, bundleEvidence, projectSource, exporterHash, sha256 } from './provenance.mjs';
import { projectIdentity } from './source-identity.mjs';

// Consistency check of the effective policy OpenShell reported at conversation creation against the one at Save and the
// revision history. It shows whether the policy changed during the conversation; it is not a snapshot taken when an action ran.
export function policyCheck({ initial, current, history }) {
  const later = initial && Number.isFinite(Number(initial.version)) ? history.versions.filter(v => v.version > Number(initial.version)).map(v => v.version) : null;
  return {
    method: 'compares the effective policy reported at creation with the one reported at Save, and the revision history; not a snapshot taken when any action ran',
    at_creation: initial ? { version: initial.version ?? null, hash: initial.hash ?? null } : null,
    at_save: { version: current.version ?? null, hash: current.hash ?? null },
    later_revisions: later,
    unchanged_since_creation: initial && later ? initial.hash === current.hash && later.length === 0 : null,
    revisions_kept: history.versions.map(v => v.version),
    history_complete: history.complete,
  };
}

// 'conv-' plus 10 hex characters: 15 characters, within the 19-character sandbox name limit.
export function newConversationId() { return `conv-${randomBytes(5).toString('hex')}`; }
export function conversationAllowed(path) { return path === '/chat/main' || path === '/chat/main/'; }
export class ConversationManager {
  constructor({root,state,run}) {
    this.root=root; this.state=state; this.run=run; this.busy=false; this.removing=new Set();
    this.file=resolve(root,'.local/conversations.json');
    this.items=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):[];
    for(const item of this.items) if(item.status==='creating') { item.status='interrupted'; item.message='Creation was interrupted. Inspect the retained sandbox before retrying.'; }
    this.persist();
  }
  persist(){writeFileSync(this.file,JSON.stringify(this.items,null,2));}
  pins(){
    const file=resolve(this.root,'setup/pins.env');
    if(!existsSync(file))return {};
    return Object.fromEntries(readFileSync(file,'utf8').split(/\r?\n/).map(l=>/^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map(m=>[m[1],m[2].trim()]));
  }
  // Preset names from setup/pins.env (POLICY_EXTRA_PRESETS); only plain preset names are accepted.
  extraPresets(){
    const file=resolve(this.root,'setup/pins.env');
    if(!existsSync(file))return [];
    const line=readFileSync(file,'utf8').split(/\r?\n/).find(l=>l.startsWith('POLICY_EXTRA_PRESETS='));
    return (line?line.slice(line.indexOf('=')+1):'').split(',').map(s=>s.trim()).filter(s=>/^[a-z][a-z0-9-]{0,39}$/.test(s));
  }
  list(){return this.items.map(({id,title,task,status,message,port,createdAt,sandboxId,closedAt,policyTier,experimentMode,taskRef,execution})=>({id,title,task,status,message,port,createdAt,sandboxId,closedAt:closedAt||null,policyTier:policyTier||null,taskSource:taskRef?.task_source||'custom_manual',taskId:taskRef?.task_id||null,executionId:execution?.execution_id||null,experimentMode:experimentMode||'autonomous_agent'}));}
  context(origin){return this.items.find(i=>i.status==='ready'&&origin===`http://127.0.0.1:${i.port}`);}
  item(id){const item=this.items.find(i=>i.id===id);if(!item)throw Error('Unknown conversation.');return item;}
  async shell(args,timeout=75000){return (await this.run('wsl.exe',['-d','Ubuntu-24.04','--',`/home/${this.state.linuxUser}/.local/bin/openshell`,...args],{timeout,maxBuffer:4*1024*1024,windowsHide:true})).stdout;}
  async nemo(args,extra=[],timeout=900000){return (await this.run('wsl.exe',['-d','Ubuntu-24.04','--','env',`PATH=/home/${this.state.linuxUser}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,'NEMOCLAW_DISABLE_TELEMETRY=1',...extra,`/home/${this.state.linuxUser}/.local/bin/nemoclaw`,...args],{timeout,maxBuffer:8*1024*1024,windowsHide:true})).stdout;}
  async verify(item){const identity=JSON.parse(await this.shell(['sandbox','get',item.id,'--output','json']));if(!item.sandboxId||identity.id!==item.sandboxId)throw Error('Sandbox identity changed. Evidence collection stopped.');return identity;}
  async containerOf(item){
    const docker='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
    const {stdout}=await this.run(docker,['ps','--format','{{.Names}}'],{windowsHide:true});
    const names=stdout.trim().split(/\r?\n/).filter(n=>n===`openshell-default--${item.id}-${item.sandboxId}`);
    if(names.length!==1)throw Error('The conversation container identity could not be verified.');
    return {docker,container:names[0]};
  }
  // The policy tier a new conversation is created with: one of NemoClaw's own tiers. Personal is not offered: NemoClaw does not apply it to a sandbox whose model endpoint is an attached provider (ours).
  tierFor(requested){
    const tier=String(requested??this.pins().POLICY_TIER??'balanced').trim().toLowerCase();
    if(!['restricted','balanced','open'].includes(tier))throw Error('Policy tier must be restricted, balanced or open.');
    return tier;
  }
  // Optional plan metadata (id, family, group, wave) kept with the conversation so samples can be split by family.
  planFor(plan){
    if(plan===undefined||plan===null)return null;
    if(typeof plan!=='object'||Array.isArray(plan))throw Error('plan must be an object.');
    const out={};
    for(const key of ['id','family','group','run_id'])if(plan[key]!==undefined){if(!/^[A-Za-z0-9._:-]{1,80}$/.test(String(plan[key])))throw Error(`plan.${key} must be 1-80 letters, digits or ._:-`);out[key]=String(plan[key]);}
    if(plan.external_dependency!==undefined){if(!DEPENDENCY_MODES.includes(plan.external_dependency))throw Error(`plan.external_dependency must be one of ${DEPENDENCY_MODES.join(', ')}.`);out.external_dependency=plan.external_dependency;}
    if(plan.wave!==undefined){if(!Number.isInteger(plan.wave)||plan.wave<0||plan.wave>99)throw Error('plan.wave must be an integer from 0 to 99.');out.wave=plan.wave;}
    return out;
  }
  // Where the task comes from. A catalog task is read from safety-router-dataset/task-catalog/ here (the text, version and hash are the catalog's, never the browser's);
  // a custom manual task is typed by the person and is not added to the catalog.
  taskRefFor(request){
    const source=request.taskSource===undefined?'custom_manual':request.taskSource;
    if(source==='task_catalog'){
      const catalog=loadCatalog(this.root);
      const t=catalog.selectable.find(x=>x.task_id===String(request.taskId));
      if(!t)throw Error('That task is not an enabled task of the catalog.');
      const problems=catalog.errors.filter(e=>e.includes(t.task_id));
      if(problems.length)throw Error('That task has catalog errors; run node safety-router-dataset/collect-data/validate-task-catalog.mjs.');
      if(request.expect&&(request.expect.version!==t.version||request.expect.hash!==t.hash))throw Error('The task changed since it was selected.');
      return {task_source:'task_catalog',task_id:t.task_id,task_version:t.version,task_hash:t.hash,category:t.category,title:String(request.title||t.title).trim().slice(0,120),task:t.task_text,task_type:t.task_type??null,single_action:t.single_action??null};
    }
    // Only Single-Action Policy Tests from the catalog can be created; custom manual tasks are no longer an active workflow.
    throw Error('Only a Single-Action Policy Test from the task catalog can be created (taskSource must be task_catalog).');
  }
  // Collection identifiers, set by the collector for one execution.
  executionFor(value,ref){
    if(value===undefined||value===null)return null;
    if(ref.task_source!=='task_catalog')throw Error('Only a catalog task can belong to a collection execution.');
    if(typeof value!=='object'||Array.isArray(value))throw Error('execution must be an object.');
    const run=String(value.run_id),id=String(value.execution_id);
    if(!/^run-\d{8}T\d{6}-[a-f0-9]{4}$/.test(run)||!/^run-\d{8}T\d{6}-[a-f0-9]{4}-e\d{5}$/.test(id)||!id.startsWith(run+'-e'))throw Error('execution.run_id and execution.execution_id are not valid.');
    if(!Number.isInteger(value.separate_run)||value.separate_run<1||value.separate_run>20)throw Error('execution.separate_run must be a whole number from 1 to 20.');
    if(this.items.some(i=>i.execution?.execution_id===id&&['ready','creating'].includes(i.status)))throw Error('An environment for this execution already exists; every execution gets its own.');
    return {run_id:run,execution_id:id,separate_run:value.separate_run};
  }
  create(request){
    if(this.busy)throw Error('Another conversation sandbox is being created.');
    if(this.items.filter(i=>i.status==='ready'||i.status==='creating').length>=4)throw Error('Four conversation sandboxes already exist. Stop and review resources before creating more.');
    const policyTier=this.tierFor(request.policyTier);const plan=this.planFor(request.plan);
    // Every conversation is an autonomous Agent task.
    const experimentMode=request.experimentMode===undefined?'autonomous_agent':request.experimentMode;
    if(experimentMode!=='autonomous_agent')throw Error('Only autonomous Agent conversations can be created.');
    const ref=this.taskRefFor(request);const execution=this.executionFor(request.execution,ref);
    const title=ref.title;const task=ref.task;
    if(!title||title.length>120||!task||task.length>8000)throw Error('Enter a title (up to 120 characters) and task (up to 8000 characters).');
    const port=19000+(this.items.reduce((max,i)=>Math.max(max,i.port-19000),-1)+1);
    if(port>19099)throw Error('The conversation dashboard port range is exhausted.');
    const item={id:newConversationId(),title,task,port,status:'creating',createdAt:new Date().toISOString(),message:'Creating an isolated sandbox; this may take several minutes.',model:'qwen2.5:1.5b',sessionKey:'agent:main:main',policyTier,plan,experimentMode,execution,taskRef:{task_source:ref.task_source,task_id:ref.task_id,task_version:ref.task_version,task_hash:ref.task_hash,category:ref.category,task_type:ref.task_type??null,single_action:ref.single_action??null}};
    this.items.push(item);this.persist();this.busy=true;
    void (async()=>{
      try{
        const log=await this.nemo(['onboard','--fresh','--name',item.id,'--control-ui-port',String(port),'--no-sandbox-gpu','--non-interactive','--yes','--yes-i-accept-third-party-software'],['NEMOCLAW_AGENT=openclaw','NEMOCLAW_PROVIDER=ollama','NEMOCLAW_MODEL=qwen2.5:1.5b','NEMOCLAW_NON_INTERACTIVE=1','NEMOCLAW_YES=1','NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1','NEMOCLAW_NO_EXPRESS=1','NEMOCLAW_SANDBOX_GPU=0',`NEMOCLAW_SANDBOX_NAME=${item.id}`,`NEMOCLAW_DASHBOARD_PORT=${port}`,'NEMOCLAW_CONTEXT_WINDOW=32768','NEMOCLAW_MAX_TOKENS=2048',`NEMOCLAW_POLICY_TIER=${policyTier}`]);
        writeFileSync(resolve(this.root,'.local',`${item.id}-creation.log`),log.split(/\r?\n/).map(redact).join('\n'));
        // The Balanced tier lists presets that non-interactive onboarding omits; apply them so every conversation has the full tier.
        // The extra presets complete the Balanced tier; the other tiers are left exactly as NemoClaw makes them.
        if(policyTier==='balanced')for(const preset of this.extraPresets())await this.nemo([item.id,'policy','add',preset,'--yes'],[],300000);
        const identity=JSON.parse(await this.shell(['sandbox','get',item.id,'--output','json']));item.sandboxId=identity.id;
        if(!/^[0-9a-f-]{36}$/.test(item.sandboxId))throw Error('Invalid sandbox identity.');
        await this.containerOf(item);   // the container must be this conversation's own sandbox
        item.initialPolicy=JSON.parse(await this.shell(['policy','get',item.id,'--full','--output','json']));
        item.policyCheck={at:'creation',checked_at:new Date().toISOString(),version:item.initialPolicy.version??null,hash:item.initialPolicy.hash??null};
        item.status='ready';item.message='Ready. Open the conversation and use its main conversation only.';
      }catch(error){item.status='failed';item.message=redact(String(error.stderr||error.message)).slice(0,800);}
      finally{this.busy=false;this.persist();}
    })();
    return {id:item.id,status:item.status};
  }
  // Saves the evidence bundle, then stops the sandbox container (workspace and history are preserved; Open isolated chat restarts it).
  // The sandbox is stopped only if the save succeeded.
  async close(id){
    if(!/^conv-[a-f0-9]{10,12}$/.test(String(id)))throw Error('Only conversations can be closed.');
    const item=this.item(id);
    if(item.status!=='ready'||this.busy)throw Error('The conversation sandbox is not ready.');
    if(this.removing.has(id))throw Error('This conversation is being deleted.');
    const saved=await this.save(id);
    await this.verify(item);
    await this.nemo([id,'stop']);
    item.closedAt=new Date().toISOString();this.persist();
    return {closed:id,...saved};
  }
  // A person switched this conversation's policy tier from the panel. Kept with the conversation; saving evidence still compares the policy with its creation snapshot, so an edited chat never passes as unchanged.
  noteTierChange(item,entry){item.policyEdits=[...(item.policyEdits||[]),entry];this.persist();}
  async open(id){const item=this.item(id);if(item.status!=='ready')throw Error('The conversation sandbox is not ready.');await this.verify(item);if(item.closedAt){await this.nemo([item.id,'start'],[],600000);delete item.closedAt;this.persist();}await this.nemo([item.id,'connect','--probe-only'],[],240000);await this.containerOf(item);const output=await this.nemo([item.id,'dashboard-url','--quiet']);const url=output.split(/\r?\n/).find(line=>line.startsWith(`http://127.0.0.1:${item.port}/`));if(!url)throw Error('Expected local dashboard URL was not returned.');return {url};}
  // Facts that let someone rebuild the environment, each read from the running system; one that cannot be read is null, never guessed.
  async reproducibility(item,{docker,container,folder}){
    const wsl=async args=>{try{return (await this.run('wsl.exe',['-d','Ubuntu-24.04','--',...args],{timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout;}catch{return null;}};
    const dock=async args=>{try{return (await this.run(docker,args,{timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();}catch{return null;}};
    const json=text=>{try{return JSON.parse(text);}catch{return null;}};
    const tags=json(await wsl(['curl','-fsS','--max-time','5','http://127.0.0.1:11434/api/tags']));
    const digest=tags?.models?.find(m=>m.name===item.model||m.model===item.model)?.digest||null;
    const show=json(await wsl(['curl','-fsS','--max-time','10','-d',JSON.stringify({model:item.model}),'http://127.0.0.1:11434/api/show']));
    const parameters=typeof show?.parameters==='string'?show.parameters:null;
    const param=name=>{const m=parameters?new RegExp(`^${name}\\s+(\\S+)`,'m').exec(parameters):null;return m?Number(m[1]):null;};
    const imageId=container?await dock(['inspect','--format','{{.Image}}',container]):null;
    const imageName=container?await dock(['inspect','--format','{{.Config.Image}}',container]):null;
    const repoDigests=imageId?json(await dock(['image','inspect',imageId,'--format','{{json .RepoDigests}}'])):null;
    const gpu=(await wsl(['nvidia-smi','--query-gpu=name,driver_version','--format=csv,noheader']))?.trim().split(/\r?\n/)[0]?.split(',').map(s=>s.trim())||null;
    const fileHash=name=>{const f=resolve(folder,'trajectory',name);return existsSync(f)?sha256(readFileSync(f)):null;};
    const pins=this.pins();
    return {
      ollama_model_digest:digest,
      generation:{temperature:param('temperature'),seed:param('seed'),top_p:param('top_p'),top_k:param('top_k'),num_ctx:param('num_ctx')??(pins.CONTEXT_WINDOW?Number(pins.CONTEXT_WINDOW):null),max_tokens:pins.MAX_TOKENS?Number(pins.MAX_TOKENS):null,source:'Ollama /api/show parameters of the model and setup/pins.env',note:'null means the value is not set there, so the runtime default applied; the temperature and seed OpenClaw sends per request are not recorded.'},
      runtime_image_id:imageId,runtime_image_name:imageName,runtime_image_repo_digests:repoDigests,
      wsl_kernel:(await wsl(['uname','-r']))?.trim()||null,
      gpu:gpu&&gpu.length>=2?{name:gpu[0],driver_version:gpu[1]}:null,
      system_prompt_sha256:fileHash('system-prompt.txt'),tool_definitions_sha256:fileHash('tools.json'),
      nemoclaw_source:{base:pins.NEMOCLAW_BASE||null,backport:pins.NEMOCLAW_BACKPORT||null},
      project_source:projectSource(this.root),project_identity:projectIdentity(this.root),exporter_hash:exporterHash(this.root),protocol_version:PROTOCOL_VERSION,
    };
  }
  async sessions(item){const output=await this.shell(['sandbox','exec','-n',item.id,'--','openclaw','sessions','--json']);return JSON.parse(output).sessions||[];}
  async sessionCount(item){return (await this.sessions(item)).filter(s=>s.key!==item.sessionKey);}
  async events(item){
    await this.verify(item);
    if((await this.sessionCount(item)).length) return {events:[],error:'More than one conversation exists in this sandbox. Create a new isolated conversation to prevent mixed evidence.'};
    const output=await this.shell(['logs',item.id,'--source','sandbox','-n','1000']);
    const events=[...new Map(output.split(/\r?\n/).map(parseEvent).filter(Boolean).map(e=>[e.id,{...e,correlation:'dedicated_sandbox',sandboxId:item.sandboxId,task_id:item.id,backgroundPossible:true}])).values()];
    return {events:events.sort((a,b)=>b.time.localeCompare(a.time)).slice(0,80),updatedAt:new Date().toISOString(),error:null,sandbox:item.id,correlation:'dedicated_sandbox'};
  }
  // Saved bundles with per-tool-call summaries.
  captures(taskId=null){
    const dir=resolve(this.root,'.local/task-captures');
    if(!existsSync(dir))return [];
    const read=(folder,name)=>{const file=resolve(folder,name);return existsSync(file)?readFileSync(file,'utf8'):null;};
    const result=[];
    for(const captureId of readdirSync(dir).filter(n=>/^capture-[a-f0-9]{24}$/.test(n))){
      const folder=resolve(dir,captureId);
      try{
        const manifest=JSON.parse(read(folder,'manifest.json'));
        if(taskId&&manifest.task_id!==taskId)continue;
        const task=JSON.parse(read(folder,'task.json')||'{}');
        const calls=read(folder,'tool-calls.jsonl').split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
        const policyVersions=JSON.parse(read(folder,'conversation.json')||'{}').policy_versions?.map(v=>v.version)||[];
        result.push({captureId,taskId:manifest.task_id,title:task.title||manifest.task_id,savedAt:manifest.saved_at,policyVersions,policyLabel:policyLabel(JSON.parse(read(folder,'environment.json')||'{}').pins?.POLICY_TIER),toolCalls:calls.map(toolCallSummary)});
      }catch{result.push({captureId,error:'This bundle could not be read.'});}
    }
    return result.sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt)));
  }
  async exists(id){const output=(await this.shell(['sandbox','list'])).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');return output.split(/\r?\n/).some(line=>line.trim().split(/\s+/)[0]===id);}
  // Destroys one conversation sandbox and forgets it. Saved task bundles are evidence and are kept unless deleteBundles is set.
  async remove(id,{deleteBundles=false,currentId=null}={}){
    // 10 hex characters today; 12 were generated before the 19-character sandbox name limit was fixed.
    if(!/^conv-[a-f0-9]{10,12}$/.test(String(id)))throw Error('Only conversations can be deleted.');
    const item=this.item(id);
    if(item.status==='creating'||this.busy)throw Error('Wait until conversation sandbox creation finishes before deleting.');
    if(id===currentId)throw Error('Delete a conversation from the main OpenShell panel, not from inside it.');
    if(this.removing.has(id))throw Error('This conversation is already being deleted.');
    this.removing.add(id);
    try{
      if(await this.exists(id)){
        if(item.sandboxId)await this.verify(item);
        await this.nemo([id,'destroy','--yes','--no-cleanup-gateway','--keep-vllm'],[],600000);
        if(await this.exists(id))throw Error('The sandbox is still present after deletion. Its record was kept; check it before retrying.');
      }
      for(const name of [`${id}-panel.js`,`${id}-creation.log`])rmSync(resolve(this.root,'.local',name),{force:true});
      this.items=this.items.filter(i=>i.id!==id);this.persist();
      const folders=this.bundleFolders(id);
      if(deleteBundles)for(const folder of folders)rmSync(folder,{recursive:true,force:true});
      return {removed:id,bundlesDeleted:deleteBundles?folders.length:0,bundlesKept:deleteBundles?0:folders.length};
    }finally{this.removing.delete(id);}
  }
  bundleFolders(taskId){
    const dir=resolve(this.root,'.local/task-captures');
    if(!existsSync(dir))return [];
    return readdirSync(dir).filter(n=>/^capture-[a-f0-9]{24}$/.test(n)).map(n=>resolve(dir,n)).filter(folder=>{try{return JSON.parse(readFileSync(resolve(folder,'manifest.json'),'utf8')).task_id===taskId;}catch{return false;}});
  }
  async policyHistory(item){
    const listed=parsePolicyList(await this.shell(['policy','list',item.id,'--limit','1000']));
    if(!listed.length)throw Error('OpenShell returned no policy history.');
    const versions=[],policies={};
    for(const entry of listed){
      const snapshot=JSON.parse(await this.shell(['policy','get',item.id,'--rev',String(entry.version),'--full','--output','json']));
      if(!snapshot.hash?.startsWith(entry.hash_prefix))throw Error(`Policy revision ${entry.version} does not match its listed hash.`);
      policies[entry.version]=snapshot;
      versions.push({...entry,hash:snapshot.hash,created_at_ms:snapshot.created_at_ms??entry.created_at_ms,loaded_at_ms:snapshot.loaded_at_ms??null});
    }
    return {versions:versions.sort((a,b)=>a.version-b.version),policies,complete:listed.length<1000};
  }
  async environment(item,{openshellVersion,openclawVersion,policyHash,policyRevision=null,reproducibility=null}){
    const wsl=async args=>{try{return (await this.run('wsl.exe',['-d','Ubuntu-24.04','--',...args],{timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout;}catch{return null;}};
    const version=text=>/\d+\.\d+\.\d+(?:[-.\w]*)?/.exec(text||'')?.[0]||null;
    const pinsFile=resolve(this.root,'setup/pins.env');
    const pinsText=existsSync(pinsFile)?readFileSync(pinsFile,'utf8'):null;
    const pins=pinsText?Object.fromEntries(pinsText.split(/\r?\n/).map(l=>/^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map(m=>[m[1],m[2].trim()])):null;
    const tier=item.policyTier??pins?.POLICY_TIER??null;
    let presetsApplied=null;
    try{presetsApplied=[...(await this.nemo([item.id,'policy','list'])).matchAll(/^\s*\S?\s*([a-z][a-z0-9_-]*) \[(?:user-added|from [^\]]+)\]/gm)].map(m=>m[1]);}catch{}
    const list=await wsl(['ollama','list']);
    const digest=list?.split(/\r?\n/).map(l=>l.trim().split(/\s+/)).find(c=>c[0]===item.model)?.[1]||null;
    return {
      schema_version:'0.1',
      model:{configured:item.model,ollama_id:digest,ollama_digest:reproducibility?.ollama_model_digest??null},
      reproducibility,
      versions:{openshell:version(openshellVersion),openclaw:version(openclawVersion),nemoclaw:version(await this.nemo(['--version']).catch(()=>null)),ollama:version(await wsl(['ollama','--version']))},
      // The tier this conversation was created with (the pinned default unless it asked for another), and the presets NemoClaw reports as applied at Save.
      policy:{profile:tier,label:policyLabel(tier),extra_presets:tier==='balanced'?(pins?.POLICY_EXTRA_PRESETS||'').split(',').map(s=>s.trim()).filter(Boolean):[],presets_applied:presetsApplied,revision:policyRevision,hash:policyHash},
      policy_hash:policyHash,
      pins,
      pins_sha256:pinsText?createHash('sha256').update(pinsText).digest('hex'):null,
      note:'pins are the values this project was set up with; versions are what was reported at save time. A difference means the bundle came from a different environment.'
    };
  }
  async save(id){
    const item=this.item(id);await this.verify(item);
    const experimentMode='autonomous_agent';
    const captureId=`capture-${randomBytes(12).toString('hex')}`;
    let exported,docker,container,agentRunStatus=null;
    {
      const sessionsBefore=await this.sessions(item);
      if(sessionsBefore.some(s=>s.key!==item.sessionKey))throw Error('Multiple conversations detected; export stopped to avoid mixing evidence.');
      const mainBefore=sessionsBefore.find(s=>s.key===item.sessionKey);
      if(!mainBefore)throw Error('Send a task in the main chat of the conversation before saving.');
      // A run that ended in failure (for example the model produced an invalid request) is finished: its trajectory and OpenShell events are real evidence.
      if(!FINISHED_RUN_STATUSES.includes(mainBefore.status))throw Error('The task is still active or its completion is unconfirmed. Wait for it to finish before saving.');
      agentRunStatus=mainBefore.status;
      const output=await this.shell(['sandbox','exec','-n',item.id,'--','openclaw','sessions','export-trajectory','--session-key',item.sessionKey,'--output',captureId,'--json']);
      exported=JSON.parse(output);
      const sessionsAfter=await this.sessions(item);
      const mainAfter=sessionsAfter.find(s=>s.key===item.sessionKey);
      if(sessionsAfter.some(s=>s.key!==item.sessionKey)||!mainAfter||mainAfter.status!==mainBefore.status||mainAfter.sessionId!==mainBefore.sessionId||mainAfter.updatedAt!==mainBefore.updatedAt||exported.sessionId!==mainBefore.sessionId)throw Error('The conversation changed during export. Wait until it is idle and save again.');
      if(exported.outputDir!==`/sandbox/.openclaw/trajectory-exports/${captureId}`)throw Error('Unexpected trajectory export path.');
      ({docker,container}=await this.containerOf(item));
    }
    const folder=resolve(this.root,'.local/task-captures',captureId);mkdirSync(folder,{recursive:true});
    await this.run(docker,['cp',`${container}:${exported.outputDir}`,resolve(folder,'trajectory')],{windowsHide:true});
    const currentPolicy=JSON.parse(await this.shell(['policy','get',item.id,'--full','--output','json']));
    const raw=await this.shell(['logs',item.id,'--source','sandbox','-n',String(LOG_LIMIT)]);
    const events=[...new Map(raw.split(/\r?\n/).map((line,i)=>{const e=parseEvent(line);return e&&[e.id,{...e,log_line:i+1,correlation:'dedicated_sandbox',sandboxId:item.sandboxId,task_id:item.id,backgroundPossible:true}];}).filter(Boolean)).values()];
    const openshellVersion=(await this.shell(['--version'])).trim();
    // Every OpenShell line is kept in the private raw layer first, exactly as received; the sanitized layer is derived from it. Neither replaces the other.
    const evidenceIds=item.execution?{runId:item.execution.run_id,executionId:item.execution.execution_id}:{runId:'manual',executionId:`manual-${captureId}`};
    const rawEvidence=writeRawEvidence({root:this.root,...evidenceIds,text:raw,capture:{started_at:item.createdAt,ended_at:new Date().toISOString(),openshell_version:openshellVersion,sandbox_id:item.sandboxId,conversation_id:item.id,capture_id:captureId}});
    const sanitizedEvidence=writeSanitizedEvidence({root:this.root,...evidenceIds});
    const taskRef=item.taskRef||{task_source:'custom_manual',task_id:null,task_version:null,task_hash:null,category:null};
    writeFileSync(resolve(folder,'task.json'),JSON.stringify({task_id:item.id,title:item.title,requested_task:item.task,task_source:taskRef.task_source,task_text_delivery:'user_entered_task_not_auto_sent',catalog_task_id:taskRef.task_id,task_version:taskRef.task_version,task_hash:taskRef.task_hash,category:taskRef.category,...(taskRef.task_type?{task_type:taskRef.task_type,single_action:taskRef.single_action}:{}),actual_requests_source:'trajectory/',sessionKey:item.sessionKey,sessionId:exported.sessionId,agent_run_status:agentRunStatus,configured_model:item.model,policy_tier:item.policyTier??null,plan:item.plan??null,experiment_mode:experimentMode,protocol_version:PROTOCOL_VERSION},null,2));
    writeFileSync(resolve(folder,'effective-policy.json'),JSON.stringify(currentPolicy,null,2));
    writeFileSync(resolve(folder,'initial-policy.json'),JSON.stringify(item.initialPolicy,null,2));
    writeFileSync(resolve(folder,'openshell-log-sanitized.txt'),sanitizedEvidence.log);
    writeFileSync(resolve(folder,'openshell-events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    const openclawVersion=(await this.shell(['sandbox','exec','-n',item.id,'--','openclaw','--version'])).trim();
    const history=await this.policyHistory(item);
    // Revisions before the one in force when the conversation was created are sandbox setup, not part of the task: keep the policy the task ran under.
    const base=Number(item.initialPolicy?.version);
    if(Number.isFinite(base))history.versions=history.versions.filter(v=>v.version>=base);
    // Which environment produced this bundle: the pinned setup plus what was actually running. Missing parts stay null.
    const reproducibility=await this.reproducibility(item,{docker,container,folder});
    const env=await this.environment(item,{openshellVersion,openclawVersion,policyHash:currentPolicy.hash,policyRevision:currentPolicy.version,reproducibility});
    writeFileSync(resolve(folder,'environment.json'),JSON.stringify(env,null,2));
    const trajectoryText=readFileSync(resolve(folder,'trajectory','events.jsonl'),'utf8');
    const toolCalls=buildToolCalls({trajectoryText,events,policyVersions:history.versions,policies:history.policies,conversationId:item.id});
    writeFileSync(resolve(folder,'tool-calls.jsonl'),toolCalls.map(c=>JSON.stringify(c)).join('\n')+(toolCalls.length?'\n':''));
    const dependency=item.plan?.external_dependency??'live_external';
    const experiment={experiment_mode:experimentMode,protocol_version:PROTOCOL_VERSION,external_dependency:dependency,run_id:item.plan?.run_id??null,started_at:item.createdAt,completed_at:new Date().toISOString()};
    const declaration=reproducibilityDeclaration({environment:env,derivable:bundleEvidence(folder,{ignore:['manifest.json','conversation.json']}).complete});
    writeFileSync(resolve(folder,'conversation.json'),JSON.stringify({...conversationRecord({conversationId:item.id,title:item.title,task:item.task,sandboxName:item.id,sandboxId:item.sandboxId,sessionKey:item.sessionKey,sessionId:exported.sessionId,model:item.model,versions:{openshell:openshellVersion,openclaw:openclawVersion},policyVersions:history.versions,toolCalls,trajectoryText}),...experiment,reproducibility:declaration},null,2));
    const relative=d=>d.slice(this.root.length+1).replaceAll('\\','/');
    const executionDoc={schema_version:1,collection_run_id:item.execution?.run_id??null,execution_id:item.execution?.execution_id??null,task_source:taskRef.task_source,task_id:taskRef.task_id,task_version:taskRef.task_version,task_hash:taskRef.task_hash,category:taskRef.category,policy:item.policyTier??null,separate_run:item.execution?.separate_run??null,
      conversation_id:item.id,sandbox_id:item.sandboxId,capture_id:captureId,experiment_mode:experimentMode,evidence_completeness:rawEvidence.evidence_completeness,task_outcome:taskOutcome(toolCalls),experiment_mode_source:'recorded',saved_at:new Date().toISOString(),
      evidence:{run_id:evidenceIds.runId,execution_id:evidenceIds.executionId,raw_dir:relative(rawEvidence.dir),sanitized_dir:relative(sanitizedEvidence.dir),raw_manifest_sha256:rawEvidence.manifest_sha256,sanitized_manifest_sha256:sanitizedEvidence.manifest_sha256,raw_events:rawEvidence.counts.total}};
    writeFileSync(resolve(folder,'execution.json'),JSON.stringify(executionDoc,null,2));
    writeFileSync(resolve(folder,'manifest.json'),JSON.stringify({schema_version:'0.2',captureId,task_id:item.id,conversation_id:item.id,sandbox_id:item.sandboxId,session_key:item.sessionKey,session_id:exported.sessionId,saved_at:new Date().toISOString(),openshell_version:openshellVersion,openclaw_version:openclawVersion,correlation:'dedicated_sandbox',per_tool_records:'tool-calls.jsonl',execution:'execution.json',environment:'environment.json',tool_call_count:toolCalls.length,per_tool_attribution_verified:false,background_events_possible:true,policy_hash:currentPolicy.hash,policy_changed_since_creation:item.initialPolicy.hash!==currentPolicy.hash,policy_check:policyCheck({initial:item.initialPolicy,current:currentPolicy,history}),intermediate_policy_history_included:true,policy_history_complete:history.complete,policy_version_count:history.versions.length,trajectory:exported.files,event_count:events.length,log_limit:LOG_LIMIT,complete_history_guaranteed:false,ground_truth_verified:false,privacy:'private_local_only',...experiment,reproducibility:declaration},null,2));
    return {captureId,folder,experimentMode,execution:executionDoc,evidence:{raw:{dir:executionDoc.evidence.raw_dir,manifest_sha256:rawEvidence.manifest_sha256,counts:rawEvidence.counts},sanitized:{dir:executionDoc.evidence.sanitized_dir,manifest_sha256:sanitizedEvidence.manifest_sha256}},reproducibility:declaration,eventCount:events.length,toolCallCount:toolCalls.length,policyVersions:history.versions.map(v=>v.version),policyLabel:policyLabel(env.pins?.POLICY_TIER),toolCalls:toolCalls.map(toolCallSummary),warning:'Dedicated sandbox evidence; background activity may be present. Tool-call decisions carry their source and are not verified labels. Historical logs are bounded.'};
  }
}
