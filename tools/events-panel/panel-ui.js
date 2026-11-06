// The OpenShell panel inside the my-assistant OpenClaw dashboard. Chat with the Agent as usual; this panel shows what it did:
// your messages, its replies, every tool call with its arguments and result, the OpenShell decision logged for it, the
// sandbox's live OpenShell events and its policy. Everything here is read-only except the policy tier switcher in the Policy tab. Data is shown with textContent only.
(() => {
  if (document.getElementById('openshell-panel-host')) return;
  const capability = '__OPENSHELL_PANEL_CAPABILITY__';
  const service = 'http://127.0.0.1:18891';
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  const host = document.createElement('div');
  host.id = 'openshell-panel-host';
  document.body.append(host);
  const docking = document.createElement('style');
  docking.textContent = '@media(min-width:900px){body.openshell-panel-open openclaw-app{display:block;width:calc(100% - 460px)!important}}';
  document.head.append(docking);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{--bg:#f8faf9;--card:#fff;--line:#d9e2dc;--ink:#1f2d3a;--muted:#647268;--accent:#2f7a55;--allow-bg:#e5f5ec;--allow:#22704a;--deny-bg:#fdecea;--deny:#a3372a;--none-bg:#eef1f4;--none:#4d5d6c;--user:#eef4fb;--code:#f3f5f4;
      position:fixed;z-index:2147480000;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
    @media(prefers-color-scheme:dark){:host{--bg:#151b19;--card:#1d2522;--line:#33403a;--ink:#e3ebe6;--muted:#9aa89f;--accent:#7cc9a0;--allow-bg:#183a29;--allow:#8fdcb3;--deny-bg:#43201c;--deny:#f2a094;--none-bg:#262f36;--none:#b7c3cd;--user:#1d2a38;--code:#141a18}}
    *{box-sizing:border-box}button,select,input{font:inherit;color:inherit}button{cursor:pointer}[hidden]{display:none!important}
    .toggle{position:fixed;right:16px;bottom:16px;border:1px solid var(--accent);background:var(--card);color:var(--accent);border-radius:999px;padding:8px 16px;font-weight:650;box-shadow:0 4px 14px #0002}
    .panel{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);display:flex;flex-direction:column;background:var(--bg);border-left:1px solid var(--line);box-shadow:-8px 0 30px #0002}
    header{padding:14px 16px 0;border-bottom:1px solid var(--line)}
    .title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:700}.title .x{margin-left:auto;background:none;border:0;font-size:22px;line-height:1;color:var(--muted)}
    .status{font-size:12px;color:var(--muted);margin:4px 0 10px;display:flex;gap:6px;align-items:center}.dot{width:7px;height:7px;border-radius:50%;background:#c4892c}.ok .dot{background:#3f9d6d}
    .tabs{display:flex;gap:2px}.tabs button{border:0;background:none;padding:8px 12px;border-bottom:2px solid transparent;color:var(--muted);font-weight:600}.tabs button.on{color:var(--accent);border-color:var(--accent)}
    .bar{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
    .bar select{flex:1;min-width:0;border:1px solid var(--line);background:var(--card);border-radius:7px;padding:5px 8px}
    .bar label{font-size:12px;color:var(--muted);display:flex;gap:4px;align-items:center;white-space:nowrap}
    .bar button{border:1px solid var(--line);background:var(--card);border-radius:7px;padding:5px 10px}
    .summary{display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px 0}
    .body{flex:1;overflow:auto;padding:10px 16px 16px}
    .item{margin:0 0 10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
    .item.user{background:var(--user)}.item.err{border-color:var(--deny)}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.who{font-weight:650}.time{margin-left:auto;font-size:11px;color:var(--muted)}
    .text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px}
    .tag{font-size:10.5px;font-weight:750;letter-spacing:.03em;padding:2px 7px;border-radius:5px;background:var(--none-bg);color:var(--none)}
    .tag.ALLOW,.tag.ALLOWED{background:var(--allow-bg);color:var(--allow)}.tag.DENY,.tag.DENIED{background:var(--deny-bg);color:var(--deny)}
    .tool{font:600 12.5px ui-monospace,Consolas,monospace}.target{font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere;margin-top:4px;color:var(--muted)}
    .note{font-size:12px;color:var(--muted);margin-top:6px}
    details{margin-top:6px}summary{cursor:pointer;font-size:12px;color:var(--accent);font-weight:600}
    pre{margin:6px 0 0;padding:8px;background:var(--code);border-radius:7px;white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.45 ui-monospace,Consolas,monospace;max-height:280px;overflow:auto}
    .empty{padding:28px 10px;text-align:center;color:var(--muted)}
    footer{padding:8px 16px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
    .error{margin:10px 16px 0;padding:8px 10px;border-radius:7px;background:var(--deny-bg);color:var(--deny);font-size:12px;white-space:pre-wrap}
  </style>
  <button class="toggle" hidden>OpenShell</button>
  <section class="panel" aria-label="OpenShell panel">
    <header>
      <div class="title">OpenShell <span class="tag">my-assistant</span><button class="x" aria-label="Close the OpenShell panel">×</button></div>
      <div class="status"><span class="dot"></span><span class="status-text">Connecting…</span></div>
      <nav class="tabs"><button data-tab="activity" class="on">Agent activity</button><button data-tab="events">OpenShell events</button><button data-tab="policy">Policy</button></nav>
    </header>
    <div class="bar" data-for="activity"><select class="session" aria-label="Chat session"></select><label><input type="checkbox" class="live" checked> Live</label><button class="refresh">Refresh</button></div>
    <div class="bar" data-for="events" hidden><select class="filter" aria-label="Event filter"><option value="all">All activity</option><option value="decisions">ALLOWED and DENIED only</option><option value="DENIED">DENIED only</option></select><button class="refresh">Refresh</button></div>
    <div class="bar" data-for="policy" hidden><span class="policy-meta" style="flex:1;font-size:12px;color:var(--muted)"></span><button class="refresh">Reload</button></div>
    <div class="error" hidden></div>
    <div class="summary" data-for="activity"></div>
    <div class="body"></div>
    <footer>Ask the Agent something in the chat; its tool calls appear here. A decision is shown only when OpenShell logged one for that call. Only the Policy tab can change anything: it switches the policy tier.</footer>
  </section>`;

  const $ = s => root.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
  const time = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(); };
  const json = v => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  const panel = $('.panel'), toggle = $('.toggle'), body = $('.body'), errorBox = $('.error');
  let tab = 'activity', session = store.get('openshell-panel-session') || '', busy = false, shown = '';
  // Sections a person opened stay open across the 5-second refresh.
  const opened = new Set();
  const fold = (key, label, text) => { const d = el('details'); d.open = opened.has(key); d.addEventListener('toggle', () => { if (d.open) opened.add(key); else opened.delete(key); }); d.append(el('summary', null, label), el('pre', null, text)); return d; };

  async function call(path, value) {
    const init = { method: value === undefined ? 'GET' : 'POST', headers: { 'X-OpenShell-Panel': capability }, cache: 'no-store', signal: AbortSignal.timeout(120000) };
    if (value !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(value); }
    const response = await fetch(service + path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || `The OpenShell panel service answered ${response.status}.`);
    return data;
  }
  const setStatus = (ok, text) => { $('.status').classList.toggle('ok', ok); $('.status-text').textContent = text; };
  const showError = text => { errorBox.hidden = !text; errorBox.textContent = text || ''; };

  function setOpen(open) {
    panel.hidden = !open; toggle.hidden = open;
    document.body.classList.toggle('openshell-panel-open', open);
    store.set('openshell-panel-open', open ? '1' : '0');
    if (open) refresh();
  }
  function setTab(next) {
    tab = next;
    root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    root.querySelectorAll('[data-for]').forEach(n => { n.hidden = n.dataset.for !== tab; });
    body.replaceChildren(); refresh();
  }

  // ---- Agent activity ----
  function decisionTag(o) {
    if (o.decision === 'ALLOW') return el('span', 'tag ALLOW', 'OPENSHELL ALLOWED');
    if (o.decision === 'DENY') return el('span', 'tag DENY', o.source === 'derived_from_static_policy' ? 'DENIED BY POLICY (derived)' : 'OPENSHELL DENIED');
    return el('span', 'tag', 'NO OPENSHELL DECISION');
  }
  function targetOf(args = {}) { return args.url ?? args.targetUrl ?? args.path ?? args.file_path ?? args.command ?? args.query ?? ''; }
  function toolCard(i) {
    const card = el('div', `item${i.result.status === 'error' ? ' err' : ''}`);
    const row = el('div', 'row');
    row.append(el('span', 'tool', `🔧 ${i.name}`), decisionTag(i.openshell), el('span', `tag${i.result.status === 'error' ? ' DENY' : i.result.status === 'ok' ? ' ALLOW' : ''}`, i.result.status === 'ok' ? 'RESULT OK' : i.result.status === 'error' ? 'RESULT ERROR' : 'NO RESULT YET'), el('span', 'time', time(i.ts)));
    card.append(row);
    const target = targetOf(i.arguments);
    if (target) card.append(el('div', 'target', target));
    const why = [i.openshell.rule, i.openshell.note].filter(Boolean).join(' · ');
    if (why) card.append(el('div', 'note', why));
    card.append(fold(`${i.id}:args`, 'Arguments', json(i.arguments)));
    if (i.result.text !== null) card.append(fold(`${i.id}:result`, `Result${i.result.exit_code !== null ? ` (exit code ${i.result.exit_code})` : ''}`, i.result.text));
    if (i.events.length) {
      card.append(fold(`${i.id}:events`, `OpenShell events during this call (${i.events.length})`, i.events.map(e => `${time(e.time)}  ${e.decision.padEnd(8)} ${e.type}  ${e.method ? `${e.method} ` : ''}${e.host ?? ''}${e.port ? `:${e.port}` : ''}${e.policy ? `  policy ${e.policy}` : ''}${e.reason ? `\n          ${e.reason}` : ''}`).join('\n')));
    }
    return card;
  }
  function renderActivity(data) {
    const select = $('.session');
    const keys = data.sessions.map(s => s.key).join('|');
    if (select.dataset.keys !== keys) {
      select.dataset.keys = keys;
      select.replaceChildren(el('option', null, 'Latest chat'), ...data.sessions.map(s => { const o = el('option', null, `${s.key.replace(/^agent:main:/, '')} · ${s.status ?? '?'} · ${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}`); o.value = s.key; return o; }));
      select.firstChild.value = '';
    }
    select.value = session;
    const sum = root.querySelector('.summary[data-for="activity"]');
    sum.replaceChildren();
    if (data.counts) {
      sum.append(el('span', 'tag', `${data.counts.messages} messages`), el('span', 'tag', `${data.counts.tool_calls} tool calls`));
      if (data.counts.allowed) sum.append(el('span', 'tag ALLOW', `${data.counts.allowed} allowed`));
      if (data.counts.denied) sum.append(el('span', 'tag DENY', `${data.counts.denied} denied`));
      if (data.counts.failed) sum.append(el('span', 'tag DENY', `${data.counts.failed} failed`));
      if (data.session?.status) sum.append(el('span', 'tag', `session ${data.session.status}`));
    }
    // Redraw only when the chat changed, so scrolling and open sections are left alone.
    const signature = JSON.stringify([data.session?.key, data.items]);
    if (signature === shown && body.childElementCount) return;
    shown = signature;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.replaceChildren();
    if (!data.session) { body.append(el('div', 'empty', 'No chat yet. Ask the Agent something in the chat.')); return; }
    if (!data.items.length) body.append(el('div', 'empty', 'This chat has no messages yet.'));
    for (const i of data.items) {
      if (i.kind === 'tool') { body.append(toolCard(i)); continue; }
      const card = el('div', `item ${i.kind}${i.error ? ' err' : ''}`);
      const row = el('div', 'row'); row.append(el('span', 'who', i.kind === 'user' ? 'You' : `Agent${i.model ? ` · ${i.model}` : ''}`), el('span', 'time', time(i.ts)));
      card.append(row);
      if (i.text) card.append(el('div', 'text', i.text));
      if (i.error) card.append(el('div', 'note', `Model error: ${i.error}`));
      body.append(card);
    }
    if (data.unreadable_lines?.length) body.append(el('div', 'note', `${data.unreadable_lines.length} line(s) of the export could not be read and are not shown.`));
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  // ---- OpenShell events ----
  function renderEvents(data) {
    const filter = $('.filter').value;
    const events = (data.events || []).filter(e => filter === 'all' || (filter === 'decisions' ? e.decision !== 'OBSERVED' : e.decision === filter));
    body.replaceChildren();
    if (data.error) body.append(el('div', 'note', data.error));
    if (!events.length) { body.append(el('div', 'empty', 'No matching events.')); return; }
    for (const e of events) {
      const card = el('div', 'item');
      const row = el('div', 'row'); row.append(el('span', `tag ${e.decision}`, e.decision), el('span', 'tool', e.type), el('span', 'time', time(e.time)));
      card.append(row, el('div', 'target', e.detail));
      if (e.policy || e.reason) card.append(el('div', 'note', [e.policy ? `policy ${e.policy}` : null, e.reason].filter(Boolean).join(' · ')));
      body.append(card);
    }
  }

  // ---- Policy ----
  // The tier switcher: NemoClaw's own tiers only (Restricted, Balanced, Open), never in a dataset collection sandbox.
  let tierBusy = false;
  function tierBox(t) {
    const box = el('div', 'item');
    const current = t.current ? t.labels[t.current] : 'Custom (changed by hand)';
    box.append(el('div', 'tool', `Policy tier: ${current}`));
    if (!t.editable) { box.append(el('div', 'note', t.reason)); return box; }
    const row = el('div', 'row');
    row.style.marginTop = '8px';
    for (const name of ['restricted', 'balanced', 'open']) {
      const b = el('button', null, t.labels[name]);
      b.style.cssText = 'border:1px solid var(--line);background:var(--card);border-radius:7px;padding:5px 12px' + (name === t.current ? ';border-color:var(--accent);color:var(--accent);font-weight:650' : '');
      b.disabled = name === t.current || tierBusy;
      b.addEventListener('click', () => switchTier(name, t));
      row.append(b);
    }
    box.append(row, el('div', 'note', 'Switching adds or removes NemoClaw\'s own presets for this chat sandbox and takes effect at once. A chat whose policy was changed can no longer be saved as unchanged dataset evidence.'));
    return box;
  }
  async function switchTier(name, t) {
    const adds = t.tiers[name].filter(p => !t.applied.includes(p));
    const removes = t.applied.filter(p => ['restricted', 'balanced', 'open'].some(n => t.tiers[n].includes(p)) && !t.tiers[name].includes(p));
    const lines = [`Switch this chat to the ${t.labels[name]} tier?`, adds.length ? `Add: ${adds.join(', ')}` : null, removes.length ? `Remove: ${removes.join(', ')}` : null].filter(Boolean).join('\n');
    if (!window.confirm(lines)) return;
    tierBusy = true; setStatus(true, 'Applying the policy tier…'); showError('');
    try { await call('/policy/tier/set', { tier: name, confirm: true }); } catch (e) { showError(e.message); }
    tierBusy = false; refresh();
  }
  function renderPolicy(p, t) {
    const policy = p.policy || p;
    $('.policy-meta').textContent = [p.version !== undefined ? `revision ${p.version}` : null, p.hash ? `hash ${String(p.hash).slice(0, 12)}` : null].filter(Boolean).join(' · ');
    body.replaceChildren();
    if (t) body.append(tierBox(t));
    const net = policy.network_policies || {};
    const names = Object.keys(net);
    body.append(el('div', 'note', `${names.length} network policies. Hosts not listed are denied.`));
    for (const name of names) {
      const n = net[name] || {};
      const card = el('div', 'item');
      card.append(el('div', 'tool', name));
      const hosts = (n.endpoints || []).map(e => `${e.host ?? '?'}${e.port ? `:${e.port}` : ''}${e.access ? ` (${e.access})` : ''}`);
      if (hosts.length) card.append(el('div', 'target', hosts.join('\n')));
      const bins = (n.binaries || []).map(b => b.path ?? b).filter(Boolean);
      if (bins.length) card.append(el('div', 'note', `programs: ${bins.join(', ')}`));
      body.append(card);
    }
    for (const [label, value] of [['Filesystem policy', policy.filesystem_policy], ['Process and Landlock', { process: policy.process, landlock: policy.landlock }]]) {
      const d = el('details'); d.append(el('summary', null, label), el('pre', null, json(value))); body.append(d);
    }
  }

  async function refresh() {
    if (busy || panel.hidden) return;
    busy = true;
    const wanted = tab;
    try {
      if (wanted === 'activity') { setStatus(true, 'Reading the chat…'); const d = await call('/agent/activity', { sessionKey: session || null }); if (tab === wanted) renderActivity(d); setStatus(true, `Updated ${new Date().toLocaleTimeString()}`); }
      else if (wanted === 'events') { const d = await call('/events'); if (tab === wanted) renderEvents(d); setStatus(true, `Updated ${new Date().toLocaleTimeString()}`); }
      else { const d = await call('/policy'); const t = await call('/policy/tier'); if (tab === wanted) renderPolicy(d, t); setStatus(true, 'Policy loaded'); }
      showError('');
    } catch (e) {
      const offline = e instanceof TypeError;
      setStatus(false, offline ? 'Offline — run Start OpenClaw Workspace.cmd' : 'Error');
      showError(offline ? 'The OpenShell panel service on 127.0.0.1:18891 is not answering. Run Start OpenClaw Workspace.cmd.' : e.message);
      if (wanted === 'activity' && /no longer exists/.test(e.message)) { session = ''; store.set('openshell-panel-session', ''); }
    } finally { busy = false; }
  }

  toggle.addEventListener('click', () => setOpen(true));
  $('.x').addEventListener('click', () => setOpen(false));
  root.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  root.querySelectorAll('.refresh').forEach(b => b.addEventListener('click', refresh));
  $('.session').addEventListener('change', e => { session = e.target.value; store.set('openshell-panel-session', session); body.replaceChildren(el('div', 'empty', 'Loading…')); refresh(); });
  $('.filter').addEventListener('change', refresh);
  setInterval(() => { if (document.visibilityState === 'visible' && (tab !== 'activity' || $('.live').checked) && tab !== 'policy') refresh(); }, 5000);
  setOpen(store.get('openshell-panel-open') !== '0');
})();
