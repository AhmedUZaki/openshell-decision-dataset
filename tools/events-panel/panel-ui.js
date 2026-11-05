(() => {
  if (document.getElementById('openshell-events-host')) return;
  const capability = '__OPENSHELL_PANEL_CAPABILITY__';
  const currentSandbox = '__OPENSHELL_SANDBOX_NAME__';
  const conversationPath = () => window.location.pathname + window.location.search;
  const host = document.createElement('div');
  host.id = 'openshell-events-host';
  document.body.append(host);
  const docking = document.createElement('style');
  docking.textContent = '@media(min-width:801px){body.openshell-panel-open openclaw-app{display:block;width:calc(100% - 420px)!important}}@media(min-width:801px) and (max-width:1100px){body.openshell-panel-open openclaw-app{width:calc(100% - 360px)!important}}';
  document.head.append(docking);
  document.body.classList.add('openshell-panel-open');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{position:fixed;right:16px;top:64px;z-index:2147480000;font:13px/1.5 system-ui,sans-serif;color:#203044}
    *{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer}
    .toggle{float:right;border:1px solid #b5cbbf;background:#f0faf4;border-radius:10px;padding:9px 13px;color:#245943;box-shadow:0 3px 12px #0001;font-weight:650}
    .panel{clear:both;margin-top:48px;width:min(390px,calc(100vw - 32px));max-height:calc(100vh - 140px);display:flex;flex-direction:column;background:#fafcfb;border:1px solid #cbd7d0;border-radius:14px;box-shadow:0 12px 40px #0002;overflow:hidden}
    @media(min-width:801px) and (max-width:1100px){.panel{width:330px}}
    [hidden]{display:none!important}.head{padding:16px;border-bottom:1px solid #dde5df}.title{font-size:17px;font-weight:700;display:flex;justify-content:space-between;align-items:center}.close{background:none;border:0;font-size:21px;color:#526174}
    .sub{font-size:12px;color:#66736c;margin-top:5px}.status{display:flex;align-items:center;gap:6px;font-size:12px;margin:10px 0;color:#2a6550}.dot{width:7px;height:7px;background:#4b9f73;border-radius:50%}.offline .dot{background:#c47b26}
    .controls{display:flex;align-items:center;justify-content:space-between;gap:8px}select{border:1px solid #cad5ce;border-radius:7px;background:white;padding:5px 8px;color:#334b3e}.note{font-size:11px;color:#69776e;margin-top:10px}
    .events{overflow:auto;padding:10px;min-height:110px}.event{padding:11px;margin-bottom:8px;background:#fff;border:1px solid #e0e7e2;border-radius:9px}.row{display:flex;align-items:center;gap:7px}.tag{font-size:10px;letter-spacing:.04em;font-weight:750;padding:2px 6px;border-radius:4px;background:#eaf0f5;color:#4b6377}.DENIED{background:#fff0ed;color:#a13b2b}.ALLOWED{background:#e6f5ed;color:#26714c}.time{font-size:11px;color:#78827c;margin-left:auto}.type{font-size:11px;color:#64736a}.detail{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,monospace;margin-top:8px}.empty{padding:24px 14px;color:#6d7c71;text-align:center}.foot{padding:9px 15px;border-top:1px solid #dde5df;font-size:11px;color:#7a857d}.note.shared{background:#fff4dc;color:#775315;padding:7px 9px;border-radius:6px}
  </style>
  <button class="toggle" aria-expanded="true">OpenShell</button>
  <section class="panel" aria-label="OpenShell sandbox events">
    <header class="head"><div class="title">OpenShell <button class="close" aria-label="Close events panel">×</button></div>
    <div class="sub"></div>
    <div class="status"><span class="dot"></span><span class="status-text">Connecting…</span></div>
    <div class="controls"><select aria-label="Event filter"><option value="all">All activity</option><option value="decisions">Explicit decisions</option><option value="DENIED">Denied only</option></select><label><input type="checkbox" checked> Live</label></div>
    <div class="note">Dedicated conversation sandboxes separate conversations. Background activity can still occur; these events are not verified per-tool labels.</div></header>
    <div class="events" aria-live="polite"></div><footer class="foot">Local connection · Policies are read-only</footer>
  </section>`;
  const policyStyles = document.createElement('style');
  policyStyles.textContent = `.tabs{display:flex;gap:6px;margin:12px 0}.tabs button,.policy button{border:1px solid #bbcfc2;border-radius:7px;background:white;padding:6px 10px;color:#28543d}.tabs button.active{background:#def0e5;font-weight:700}.policy{overflow:auto;padding:14px}.policy label{display:block;margin-top:9px;color:#465b4d;font-size:12px}.policy input,.policy select,.policy textarea{display:block;width:100%;margin-top:4px;padding:7px;border:1px solid #cbd7d0;border-radius:6px;background:white;color:#203044;font:12px/1.5 system-ui}.policy textarea{min-height:150px;font-family:ui-monospace,monospace;white-space:pre}.policy input[type=checkbox]{display:inline;width:auto;margin-right:5px}.policy .actions{display:flex;gap:8px;margin-top:12px}.policy button:disabled{opacity:.45;cursor:default}.policy .feedback{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.policy .warning{background:#fff4dc;color:#775315;padding:9px;border-radius:6px;font-size:12px}.policy details{margin:10px 0}.policy summary{cursor:pointer;font-weight:600}.policy pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.policy .meta{font-size:11px;color:#68786e;overflow-wrap:anywhere}.policy .openrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}.policy .openbox{display:inline-block;margin:0;padding:7px 12px;border:2px solid #3f9468;border-radius:8px;background:#e3f4eb;color:#1b5a3d;font-size:13px;font-weight:700;text-align:center;text-decoration:none;box-shadow:0 2px 8px #0001;cursor:pointer}.policy .openbox:hover,.policy .openbox:focus-visible{background:#d2eddf;outline:2px solid #2d7a53;outline-offset:2px}.policy .openbox small{display:block;margin-top:4px;font-size:11px;font-weight:500;color:#456e58;overflow-wrap:anywhere}`;
  root.append(policyStyles);
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  tabs.innerHTML = '<button data-tab="conversation">Conversation</button><button data-tab="policies">Policies</button><button class="active" data-tab="events">Events</button>';
  root.querySelector('.sub').after(tabs);
  root.querySelector('.sub').textContent = `Sandbox · ${currentSandbox}`;
  const conversationView = document.createElement('section'); conversationView.className='policy'; conversationView.hidden=true;
  conversationView.setAttribute('aria-label','Isolated conversations');
  conversationView.innerHTML = `<div class="warning">One conversation per sandbox. Use its main chat only. Each new environment consumes memory and disk. Saving includes private task text and trajectory files.</div>
    <div class="note">Single-Action Policy Tests: one Agent tool call, once, against one destination, in one isolated Sandbox under one unchanged policy.</div>
    <div id="conversation-catalog-box">
      <label>Single-Action Policy Test<select id="conversation-catalog-task"></select></label>
      <div class="meta" id="conversation-task-meta"></div>
      <label>Task text (sent to the Agent exactly as written; to change it, edit its file in safety-router-dataset/task-catalog)<textarea id="conversation-task-text" readonly></textarea></label>
    </div>
    <label>Policy<select id="conversation-policy"><option value="restricted">Restricted</option><option value="balanced" selected>Balanced — NemoClaw default</option><option value="open">Open</option></select></label>
    <div class="actions"><button id="conversation-create">New conversation</button></div>
    <div class="feedback" id="conversation-feedback" role="status"></div>
    <label><input type="checkbox" id="conversation-delete-bundles">When deleting a conversation, also delete its saved task bundles (cannot be undone)</label>
    <div id="conversation-list"></div>
    <div id="conversation-save-feedback" class="feedback" role="status"></div><div id="conversation-tool-calls"></div>
    <details open><summary>Saved task bundles and tool calls</summary><div id="conversation-captures" class="meta">Loading…</div></details>
    <div class="note">Saved locally under .local/task-captures/ (excluded from Git). A bundle includes the task, trajectory, the policy the task ran under, one record per tool call (tool-calls.jsonl) and sandbox-scoped events. Decisions show their source; they are not independently verified labels.</div>`;
  root.querySelector('.foot').before(conversationView);
  const conversationEl = id => conversationView.querySelector(`#${id}`);
  let conversationBusy=false;
  const openedLinks=new Map();
  const openLink=url=>{const link=document.createElement('a');link.className='openbox';link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open your authenticated conversation';return link;};
  const policyView = document.createElement('section'); policyView.className = 'policy'; policyView.hidden = true;
  policyView.setAttribute('aria-label','OpenShell policy');
  policyView.innerHTML = `<div class="warning">Read-only view of the policy this sandbox is running. Every conversation uses NemoClaw's default policy, Balanced (default); it is not edited from here.</div>
    <div class="actions"><button id="reload-policy">Reload policies</button></div><div class="meta" id="policy-meta"></div>
    <details open><summary>Network policies</summary><pre id="network-policy"></pre></details>
    <details><summary>Filesystem policy</summary><pre id="filesystem-policy"></pre></details>
    <details><summary>Process and Landlock policy</summary><pre id="process-policy"></pre></details>
    <div class="feedback" id="policy-feedback" role="status"></div>`;
  root.querySelector('.foot').before(policyView);
  const byId = id => policyView.querySelector(`#${id}`);
  let selectedTab = 'events';
  const feedback = text => { byId('policy-feedback').textContent = text; };
  async function policyRequest(path, value) {
    const headers = {'X-OpenShell-Panel':capability,'X-OpenShell-Conversation':conversationPath()};
    if (value !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:18891${path}`,{method:value===undefined?'GET':'POST',headers,body:value===undefined?undefined:JSON.stringify(value),cache:'no-store',signal:AbortSignal.timeout(path==='/conversations/open'?260000:path==='/conversations/delete'?660000:path==='/conversations/close'?300000:100000)});
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Request failed.'); return result;
  }
  async function loadPolicy() {
    feedback('Loading policy…');
    try {
      const current = await policyRequest('/policy');
      byId('policy-meta').textContent = `Sandbox: ${current.sandbox} · Revision: ${current.version} · Source: ${current.policy_source}`;
      byId('network-policy').textContent = JSON.stringify(current.policy.network_policies,null,2);
      byId('filesystem-policy').textContent = JSON.stringify(current.policy.filesystem_policy,null,2);
      byId('process-policy').textContent = JSON.stringify({process:current.policy.process,landlock:current.policy.landlock},null,2);
      feedback('');
    } catch(error) { feedback(error.message); }
  }
  byId('reload-policy').onclick = loadPolicy;
  async function loadConversations(){
    if(conversationBusy)return;
    try{
      const data=await policyRequest('/conversations/list');
      const list=conversationEl('conversation-list');list.replaceChildren();
      for(const item of data.items){
        const card=document.createElement('article');card.className='event';
        const title=document.createElement('strong');title.textContent=item.title;
        const status=document.createElement('div');status.className='meta';status.textContent=`${item.status}${item.closedAt?' (closed)':''} · ${item.id}`;
        const message=document.createElement('div');message.className='meta';message.textContent=item.message;
        card.append(title,status);
        if(item.status==='failed'||item.status==='interrupted'){
          const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Show failure details';details.append(summary,message);card.append(details);
        }else card.append(message);
        const row=document.createElement('div');row.className='openrow';
        // Inside its own conversation the card offers Save and Close instead of opening itself.
        if(item.status==='ready'&&item.id===currentSandbox){
          const save=document.createElement('button');save.textContent='Save task bundle';save.disabled=conversationPath()!=='/chat/main';save.onclick=async()=>{save.disabled=true;await saveBundle();};
          const close=document.createElement('button');close.textContent='Close conversation';close.disabled=conversationPath()!=='/chat/main';close.onclick=async()=>{
            if(conversationBusy)return;
            if(!window.confirm(`Close "${item.title}" (${item.id})?\n\nIt saves the task bundle first, then stops this sandbox. Nothing is deleted; reopen it from the main OpenShell panel with Open isolated chat. This page will stop responding.`))return;
            conversationBusy=true;close.disabled=true;save.disabled=true;
            const started=Date.now();const progress=()=>{conversationEl('conversation-save-feedback').textContent=`Saving the task bundle, then stopping the sandbox (${Math.round((Date.now()-started)/1000)} s)…`;};
            progress();const ticker=setInterval(progress,1000);
            try{const result=await policyRequest('/conversations/close',{id:item.id,confirm:true});conversationEl('conversation-save-feedback').textContent=`Closed. Saved ${result.toolCallCount??0} tool calls, ${result.eventCount} events.\n${result.folder}${samplesNote(result)}\nThe sandbox is stopped. Reopen it from the main OpenShell panel.\nClosing this tab…`;renderToolCalls(result.toolCalls||[],undefined,result.policyLabel);
              // A tab opened from a link can close itself; if the browser refuses, the message below stays.
              setTimeout(()=>{window.close();setTimeout(()=>{conversationEl('conversation-save-feedback').textContent+='\n(The browser did not allow closing this tab automatically; close it manually.)';},800);},1500);}
            catch(error){conversationEl('conversation-save-feedback').textContent=error.message;close.disabled=false;save.disabled=conversationPath()!=='/chat/main';}
            finally{clearInterval(ticker);conversationBusy=false;}
          };
          row.append(save,close);
        }
        if(item.status==='ready'&&item.id!==currentSandbox){
          const button=document.createElement('button');button.textContent='Open isolated chat';button.onclick=async()=>{
            if(conversationBusy)return;conversationBusy=true;button.disabled=true;
            const started=Date.now();const progress=()=>{conversationEl('conversation-feedback').textContent=`Starting the isolated sandbox and checking its gateway (${Math.round((Date.now()-started)/1000)} s). The first open can take about a minute.`;};
            progress();const ticker=setInterval(progress,1000);
            try{const result=await policyRequest('/conversations/open',{id:item.id});openedLinks.set(item.id,result.url);row.querySelector('.openbox')?.remove();row.append(openLink(result.url));conversationEl('conversation-feedback').textContent='';}
            catch(error){conversationEl('conversation-feedback').textContent=error.message;}
            finally{clearInterval(ticker);conversationBusy=false;button.disabled=false;}
          };row.append(button);        }
        // Offered on the main panel for every conversation, and inside a conversation for itself only.
        const isSelf=item.id===currentSandbox;
        if((currentSandbox==='my-assistant'||isSelf)&&item.status!=='creating'){
          const remove=document.createElement('button');remove.textContent='Delete';remove.onclick=async()=>{
            if(conversationBusy)return;
            const withBundles=conversationEl('conversation-delete-bundles').checked;
            const text=`Delete "${item.title}" (${item.id})?\n\nThis permanently destroys its sandbox and conversation history.\n${withBundles?'Its saved task bundles will also be deleted.':'Its saved task bundles are kept.'}${isSelf?'\n\nThis is the conversation you are in; this tab will close.':''}`;
            if(!window.confirm(text))return;
            conversationBusy=true;remove.disabled=true;
            const started=Date.now();const progress=()=>{conversationEl('conversation-feedback').textContent=`Deleting ${item.id} (${Math.round((Date.now()-started)/1000)} s). This can take up to a minute.`;};
            progress();const ticker=setInterval(progress,1000);
            try{const result=await policyRequest('/conversations/delete',{id:item.id,confirm:true,deleteBundles:withBundles});conversationEl('conversation-feedback').textContent=`Deleted ${result.removed}. ${withBundles?`${result.bundlesDeleted} saved bundle(s) deleted.`:`${result.bundlesKept} saved bundle(s) kept.`}`;if(isSelf){conversationEl('conversation-feedback').textContent+='\nClosing this tab…';setTimeout(()=>window.close(),1500);}}
            catch(error){conversationEl('conversation-feedback').textContent=error.message;}
            finally{clearInterval(ticker);conversationBusy=false;if(!isSelf){loadConversations();loadCaptures();}}
          };row.append(remove);
        }
        if(item.status==='ready'&&openedLinks.has(item.id))row.append(openLink(openedLinks.get(item.id)));
        if(row.children.length)card.append(row);
        list.append(card);
      }
    }catch(error){conversationEl('conversation-feedback').textContent=error.message;}
  }
  conversationEl('conversation-create').onclick=async()=>{
    if(conversationBusy)return;conversationBusy=true;conversationEl('conversation-create').disabled=true;
    try{const body={taskSource:'task_catalog',taskId:conversationEl('conversation-catalog-task').value,policyTier:conversationEl('conversation-policy').value};const result=await policyRequest('/conversations/create',body);conversationEl('conversation-feedback').textContent=`Creating ${result.id}. This may take several minutes. Your shared chat is unchanged.`;}
    catch(error){conversationEl('conversation-feedback').textContent=error.message;}
    finally{conversationBusy=false;conversationEl('conversation-create').disabled=false;loadConversations();}
  };
  // Task catalog selectors (text only). The server owns the task text, version and hash; the browser only names the task.
  let catalogData=null;
  const showTask=()=>{
    const task=catalogData?.categories.flatMap(c=>c.tasks).find(x=>x.task_id===conversationEl('conversation-catalog-task').value);
    conversationEl('conversation-task-text').value=task?task.task_text:'';
    conversationEl('conversation-task-meta').textContent=task?[task.description,`v${task.version} · ${task.hash.slice(0,12)} · ${task.external_dependency} · about ${task.estimated_minutes} min`,`One tool call: ${task.single_action?.tool} · ${task.single_action?.arguments?.url}`,...task.safety_notes.map(n=>`Note: ${n}`)].join('\n'):'';
  };
  async function loadTaskCatalog(){
    try{
      catalogData=await policyRequest('/catalog');
      const select=conversationEl('conversation-catalog-task');select.replaceChildren();
      for(const task of catalogData.categories.flatMap(c=>c.tasks)){const o=document.createElement('option');o.value=task.task_id;o.textContent=task.title;select.append(o);}
      showTask();
      if(!catalogData.ok)conversationEl('conversation-feedback').textContent=`The task catalog has errors (run node safety-router-dataset/collect-data/validate-task-catalog.mjs): ${catalogData.errors[0]||''}`;
    }catch(error){conversationEl('conversation-task-meta').textContent=`The task catalog is available from the main OpenShell panel. ${error.message}`;}
  }
  conversationEl('conversation-catalog-task').onchange=showTask;
  loadTaskCatalog();
  // The complete timelines of one saved Bundle, as text only (never HTML): every Agent event, then every OpenShell event with its origin and decision.
  function renderTimelines(box,r){
    const part=(title,lines)=>{const d=document.createElement('details');const s=document.createElement('summary');s.textContent=`${title} (${lines.length})`;const pre=document.createElement('pre');pre.textContent=lines.join('\n');d.append(s,pre);return d;};
    const clip=(v,n=200)=>{const s=typeof v==='string'?v:JSON.stringify(v);return s==null?'null':s.length>n?s.slice(0,n)+'…':s;};
    const agent=(r.agent_timeline||[]).map(e=>`#${e.sequence} ${e.timestamp_utc??'null'} ${e.event_type}${e.tool_name?` ${e.tool_name} ${clip(e.arguments)}`:''}${e.tool_execution_status?` [${e.tool_execution_status}]`:''}${e.content!==undefined?` ${clip(e.content)}`:''}`);
    const shell=(r.openshell_timeline||[]).map(e=>`#${e.sequence} ${e.timestamp_utc??'null'} ${e.event_type} ${e.decision??'-'} ${e.event_origin}${e.destination?.host?` ${e.destination.host}:${e.destination.port??''}`:''}${e.reason?` · ${clip(e.reason,120)}`:''}`);
    const res=r.execution_results||{},pol=r.policy_result||{};
    const head=document.createElement('div');head.className='meta';head.textContent=`Policy result ${pol.final_policy_result} · completion ${res.task_completion_status} · tool ${res.tool_execution_status} · evidence ${res.evidence_completeness} · training ${res.training_eligibility}${(res.training_exclusion_reasons||[]).length?` (${res.training_exclusion_reasons.join('; ')})`:''}`;
    box.replaceChildren(head,part('Agent timeline',agent),part('OpenShell timeline',shell));
  }  async function loadCaptures(){
    const list=conversationEl('conversation-captures');
    try{
      const {captures}=await policyRequest('/conversations/captures');
      if(!captures.length){list.textContent='No saved task bundles yet.';return;}
      list.replaceChildren(...captures.map(c=>{
        const details=document.createElement('details');const summary=document.createElement('summary');
        if(c.error){summary.textContent=`${c.captureId} · ${c.error}`;details.append(summary);return details;}
        const denied=c.toolCalls.filter(t=>t.decision==='DENY').length;
        summary.textContent=`${c.title} · ${c.toolCalls.length} tool calls${denied?` · ${denied} denied`:''} · ${new Date(c.savedAt).toLocaleString()}`;
        const meta=document.createElement('div');meta.className='meta';meta.textContent=`${c.captureId} · ${c.taskId} · policy ${c.policyLabel||`versions ${c.policyVersions.join(', ')||'-'}`}`;
        const calls=document.createElement('div');renderToolCalls(c.toolCalls,calls,c.policyLabel);
        const timelineBox=document.createElement('div');const timelineButton=document.createElement('button');timelineButton.textContent='Show complete Agent and OpenShell timelines';
        timelineButton.onclick=async()=>{timelineButton.disabled=true;try{renderTimelines(timelineBox,await policyRequest('/conversations/timeline',{captureId:c.captureId}));timelineButton.remove();}catch(error){timelineBox.textContent=error.message;timelineButton.disabled=false;}};
        details.append(summary,meta,calls,timelineButton,timelineBox);return details;
      }));
    }catch(error){list.textContent=error.message;}
  }
  function renderToolCalls(calls,list=conversationEl('conversation-tool-calls'),policyName=null){
    if(!calls.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No tool calls in this conversation.';list.replaceChildren(empty);return;}
    list.replaceChildren(...calls.map(c=>{
      const card=document.createElement('div');card.className='event';
      const row=document.createElement('div');row.className='row';
      const tag=document.createElement('span');const label=c.decision==='ALLOW'?'ALLOWED':c.decision==='DENY'?'DENIED':'UNKNOWN';tag.className=`tag ${label}`;tag.textContent=c.decision||'NO DECISION';
      const name=document.createElement('span');name.className='type';name.textContent=`#${c.sequence} ${c.tool} · policy ${policyName||`v${c.policy_version??'?'}`}`;
      const time=document.createElement('span');time.className='time';time.textContent=new Date(c.requested_at).toLocaleTimeString();
      row.append(tag,name,time);
      const detail=document.createElement('div');detail.className='detail';
      detail.textContent=[c.target,`Decision source: ${c.source}`,c.rule?`Rule: ${c.rule}`:c.note,`Result: ${c.result} · evidence ${c.consistency}`,c.response?`OpenClaw: ${c.response}`:null].filter(Boolean).join('\n');
      card.append(row,detail);return card;
    }));
  }
  const decisionCounts=d=>{const n=d?.by_layer?.network||{};return `${n.ALLOW||0} ALLOW / ${n.DENY||0} DENY`;};
  const samplesNote=()=>'';
  async function saveBundle(){
    if(conversationBusy)return;conversationBusy=true;
    const out=conversationEl('conversation-save-feedback');out.textContent='Saving task, trajectory, policy and OpenShell events…';
    conversationEl('conversation-tool-calls').replaceChildren();
    try{const result=await policyRequest('/conversations/save',{id:currentSandbox});out.textContent=`Saved ${result.toolCallCount??0} tool calls, ${result.eventCount} events, policy ${result.policyLabel||`versions ${(result.policyVersions||[]).join(', ')||'-'}`}.\n${result.folder}${samplesNote(result)}\n${result.warning}`;renderToolCalls(result.toolCalls||[],undefined,result.policyLabel);loadCaptures();}
    catch(error){out.textContent=error.message;}
    finally{conversationBusy=false;}
  }
  for (const button of tabs.querySelectorAll('button')) button.onclick = () => {
    selectedTab = button.dataset.tab;
    for (const tab of tabs.querySelectorAll('button')) tab.classList.toggle('active',tab===button);
    policyView.hidden = selectedTab!=='policies';
    conversationView.hidden = selectedTab!=='conversation';
    root.querySelector('.events').hidden = selectedTab!=='events';
    root.querySelector('.controls').hidden = selectedTab!=='events';
    root.querySelector('.note').hidden = selectedTab!=='events';
    if (selectedTab==='policies') loadPolicy(); else if(selectedTab==='conversation'){loadConversations();loadCaptures();loadTaskCatalog();}else refresh();
  };
  const panel = root.querySelector('.panel');
  const toggle = root.querySelector('.toggle');
  const list = root.querySelector('.events');
  const filter = root.querySelector('select');
  const live = root.querySelector('input');
  let events = [];
  let signature = '';
  let scope = null;
  const defaultNote = root.querySelector('.note').textContent;
  const sharedNote = 'Sandbox-wide view: events from every conversation in the shared my-assistant sandbox, plus background activity. They are not linked to this chat and are not dataset evidence. Use the Conversation tab for conversation-scoped records.';
  function setOpen(open) { panel.hidden = !open; document.body.classList.toggle('openshell-panel-open', open); toggle.setAttribute('aria-expanded', String(open)); if (open) refresh(); }
  toggle.onclick = () => setOpen(panel.hidden);
  root.querySelector('.close').onclick = () => setOpen(false);
  function render() {
    const shown = events.filter(e => filter.value === 'all' || (filter.value === 'decisions' ? e.decision !== 'OBSERVED' : e.decision === filter.value));
    const next = JSON.stringify([scope, shown]);
    if (signature === next) return;
    signature = next;
    list.replaceChildren();
    if (!shown.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No matching events in the current log window.'; list.append(empty); return; }
    for (const event of shown) {
      const card = document.createElement('article'); card.className = 'event';
      const row = document.createElement('div'); row.className = 'row';
      const tag = document.createElement('span'); tag.className = `tag ${event.decision}`; tag.textContent = event.decision;
      const type = document.createElement('span'); type.className = 'type'; type.textContent = event.type;
      const time = document.createElement('time'); time.className = 'time'; time.dateTime = event.time; time.textContent = new Date(event.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}); time.title = new Date(event.time).toLocaleString();
      const detail = document.createElement('div'); detail.className = 'detail'; detail.textContent = event.detail;
      row.append(tag, type);
      if (scope === 'shared_sandbox') { const shared = document.createElement('span'); shared.className = 'tag'; shared.textContent = 'SANDBOX-WIDE'; shared.title = 'Not linked to this conversation'; row.append(shared); }
      row.append(time); card.append(row, detail); list.append(card);
    }
  }
  filter.onchange = () => { signature = ''; render(); };
  let fetching = false;
  async function refresh() {
    if (fetching || panel.hidden || selectedTab!=='events' || !live.checked || document.hidden) return;
    fetching = true;
    try {
      const requestedConversation=conversationPath();
      const res = await fetch('http://127.0.0.1:18891/events', { headers: { 'X-OpenShell-Panel': capability,'X-OpenShell-Conversation':requestedConversation }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw Error('Events service unavailable');
      const data = await res.json();if(requestedConversation!==conversationPath())return; events = data.events; scope = data.scope || null; render();
      const note = root.querySelector('.note');
      note.textContent = scope === 'shared_sandbox' ? sharedNote : defaultNote;
      note.className = scope === 'shared_sandbox' ? 'note shared' : 'note';
      root.querySelector('.status').classList.toggle('offline', Boolean(data.error));
      root.querySelector('.status-text').textContent = data.error || (scope === 'shared_sandbox' ? `Live · ${events.length} recent events · ${data.notice}` : data.notice || `Live · ${events.length} recent events`);
    } catch {
      root.querySelector('.status').classList.add('offline');
      root.querySelector('.status-text').textContent = 'Offline — run Start OpenClaw.cmd to reconnect';
    } finally { fetching = false; }
  }
  live.onchange = refresh;
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 4000);
  setInterval(()=>{if(selectedTab==='conversation'&&!panel.hidden&&!document.hidden)loadConversations();},4000);
  let lastConversation=conversationPath();
  setInterval(()=>{const path=conversationPath();if(path!==lastConversation){lastConversation=path;events=[];signature='';render();root.querySelector('.status-text').textContent='Checking this conversation…';if(selectedTab==='events')refresh();}},300);
  refresh();
  // Conversation (internally "conversation") is the first and default tab.
  const requestedTab=new URL(window.location.href).searchParams.get('openshell-panel');
  (tabs.querySelector(`[data-tab="${requestedTab==='policies'||requestedTab==='events'?requestedTab:'conversation'}"]`)).click();
})();
