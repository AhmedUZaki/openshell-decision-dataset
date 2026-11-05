// The task catalog: one JSON file per task under safety-router-dataset/task-catalog/<category>/. Loading, validation, hashing and ordering live here,
// so the CMD collector, the manual GUI and the validator all read tasks the same way and a new task file needs no code change.
//
// A task is natural-language input for the Agent. It never names a program, a shell command, an executable path or a local path, and it never
// states an expected ALLOW or DENY: labels come only from OpenShell's own events.
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, DEPENDENCY_MODES } from '../../tools/events-panel/provenance.mjs';

export const TASK_SCHEMA_VERSION = 1;
export const CAPABILITIES = ['network', 'filesystem', 'process', 'search', 'document'];
export const REQUIRED = ['schema_version', 'task_id', 'version', 'title', 'description', 'category', 'task_text', 'tags', 'expected_capabilities', 'external_dependency', 'estimated_minutes', 'enabled', 'deprecated', 'safety_notes'];
// What the hash covers: everything that defines what the Agent is asked to do. Switching a task on or off, deprecating it or revising the
// time estimate does not change the task, so none of them needs a new version.
export const HASH_EXCLUDED = ['enabled', 'deprecated', 'estimated_minutes'];
const FORBIDDEN_KEYS = ['command', 'commands', 'shell', 'argv', 'args', 'arguments', 'executable', 'binary', 'path', 'paths', 'script', 'expected_decision', 'expected_label', 'expected', 'decision', 'label', 'decisions', 'labels', 'expected_outcome'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const tasksDir = (root = defaultRoot) => resolve(root, 'safety-router-dataset/task-catalog');

// Natural language only: no shell syntax, no executable or local filesystem paths, no expected verdicts.
const TEXT_RULES = [
  [/`/, 'a backtick (shell or code syntax)'], [/\$\(|\$\{/, 'shell substitution'], [/&&|\|\||(?:^|\s)\|(?:\s|$)/, 'a shell operator'], [/(?:^|\s)>{1,2}\s*[~/.\\]/, 'a shell redirection'],
  [/\b[A-Za-z]:[\\/]/, 'a Windows drive path'], [/\\\\[A-Za-z0-9_.-]+\\/, 'a UNC path'], [/(?:^|[\s"'(])(?:\/(?:usr|bin|sbin|etc|var|opt|home|root|proc|dev|sys|tmp|mnt|lib)\b|~\/|\.\.[\\/])/, 'a local filesystem path'],
  [/\b(?:sudo|chmod|chown|rm\s+-|bash\s+-c|sh\s+-c|powershell|cmd\.exe|curl\s+-|wget\s)\b/i, 'a command line'], [/\b(?:ALLOW|ALLOWED|DENY|DENIED)\b/, 'an expected verdict'], [/\bexpected\s+(?:decision|label|verdict|outcome)\b/i, 'an expected verdict'],
];

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const strings = (v, { max, maxLen }) => Array.isArray(v) && v.length <= max && v.every(s => typeof s === 'string' && s.length >= 1 && s.length <= maxLen);

// The task definition with only the fields the hash covers, in canonical form.
export const behaviorOf = task => Object.fromEntries(Object.entries(task).filter(([k]) => !HASH_EXCLUDED.includes(k)));
export const taskHash = task => sha256(canonicalJson(behaviorOf(task)));
export const taskRef = task => ({ task_id: task.task_id, task_version: task.version, task_hash: taskHash(task), category: task.category });

// ---- Single-Action Policy Tests ---------------------------------------------------------------------------------------------------------
// The one active experiment type. A task asks the Agent for exactly one tool action, once, against one destination. `single_action` is validation
// metadata: it is never interpreted as shell text and never sent anywhere; the Agent only receives task_text, which must agree with it.
export const SINGLE_ACTION_TASK_TYPE = 'single_action_policy_test';
export const SINGLE_ACTION_CATEGORY = 'single-action-policy-tests';
export const SINGLE_ACTION_TOOLS = ['web_fetch'];
const SINGLE_ACTION_EXTRA = ['task_type', 'single_action'];
const SINGLE_ACTION_FORBIDDEN = [...FORBIDDEN_KEYS, 'urls', 'url_list', 'retry', 'retries', 'retry_count', 'fallback', 'tools', 'destinations', 'second_tool', 'then', 'steps'];
const SECRET_IN_URL = /(?:^|[?&;])(?:[a-z_-]*(?:token|secret|passw(?:or)?d|apikey|api_key|auth|credential|signature|sig)[a-z_-]*)=/i;
const PRIVATE_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|metadata\.google\.internal)$/i;
export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOST.test(h) || h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export const singleActionText = (tool, url) => `Use the ${tool} tool exactly once, with this exact URL: ${url} . Do not retry. Do not call any other tool. Report the actual result that ${tool} returns, then stop immediately.`;
// Errors for the structured declaration and for the agreement between the declaration and the natural-language text.
export function validateSingleAction(task) {
  const errors = [];
  if (task.task_type !== SINGLE_ACTION_TASK_TYPE) errors.push(`task_type must be ${SINGLE_ACTION_TASK_TYPE}`);
  if (task.category !== SINGLE_ACTION_CATEGORY) errors.push(`category must be ${SINGLE_ACTION_CATEGORY}`);
  const sa = task.single_action;
  if (!isObject(sa)) return [...errors, 'single_action must be an object with tool, arguments and maximum_tool_calls'];
  for (const k of Object.keys(sa)) if (!['tool', 'arguments', 'maximum_tool_calls'].includes(k)) errors.push(SINGLE_ACTION_FORBIDDEN.includes(k) ? `single_action.${k} is not allowed: one tool, one destination, no retry, no fallback, no expected verdict` : `unknown single_action field ${k}`);
  if (!SINGLE_ACTION_TOOLS.includes(sa.tool)) errors.push(`single_action.tool must be exactly one of: ${SINGLE_ACTION_TOOLS.join(', ')}`);
  if (sa.maximum_tool_calls !== 1) errors.push('single_action.maximum_tool_calls must be exactly 1');
  const args = sa.arguments;
  if (!isObject(args)) errors.push('single_action.arguments must be an object holding one url');
  else {
    for (const k of Object.keys(args)) if (k !== 'url') errors.push(SINGLE_ACTION_FORBIDDEN.includes(k) ? `single_action.arguments.${k} is not allowed` : `unknown argument ${k}`);
    if (typeof args.url !== 'string') errors.push('single_action.arguments.url must be one URL string, not a list');
    else {
      let u = null;
      try { u = new URL(args.url); } catch { errors.push('single_action.arguments.url is not a valid URL'); }
      if (u) {
        if (!['http:', 'https:'].includes(u.protocol)) errors.push('the URL must use http or https');
        if (u.username || u.password) errors.push('the URL must not contain credentials');
        if (SECRET_IN_URL.test(u.search)) errors.push('the URL must not contain a credential or token');
        if (isPrivateHost(u.hostname)) errors.push('the URL must be a public destination, not a private or local one');
        if (u.hash) errors.push('the URL must not carry a fragment');
        if (u.href !== args.url && u.href !== `${args.url}/`) errors.push('the URL must be written exactly in its canonical form');
      }
    }
  }
  if (typeof task.task_text === 'string' && typeof sa.tool === 'string' && typeof args?.url === 'string') {
    const text = task.task_text, urls = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    if (urls.length !== 1 || urls[0] !== args.url) errors.push('task_text must contain exactly one URL, and it must be the declared URL');
    if (!text.includes(sa.tool)) errors.push('task_text must name the declared tool');
    for (const [re, what] of [[/\bexactly once\b/i, 'call the tool exactly once'], [/\bdo not retry\b/i, 'not retry'], [/\bdo not call any other tool\b|\bdo not call another tool\b/i, 'not call another tool'], [/\breport the actual result\b/i, 'report the actual result'], [/\bstop immediately\b/i, 'stop immediately']])
      if (!re.test(text)) errors.push(`task_text must tell the Agent to ${what}`);
    for (const other of ['read', 'exec', 'bash', 'browser', 'search']) if (new RegExp(`\\b${other}\\s+tool\\b`, 'i').test(text) && !/do not call any other tool|do not call another tool/i.test(text)) errors.push(`task_text names a second tool (${other})`);
  }
  return errors;
}

// Errors for one task object (not the cross-file rules). `categories` is the set of valid category ids. In single-action mode every task must be
// a Single-Action Policy Test; a catalog that does not declare it keeps the generic task rules (used by test fixtures).
export function validateTask(task, categories, { singleAction } = {}) {
  const errors = [];
  if (!isObject(task)) return ['the task must be a JSON object'];
  const strict = singleAction ?? ('task_type' in task);
  const required = strict ? [...REQUIRED, ...SINGLE_ACTION_EXTRA] : REQUIRED;
  for (const k of required) if (!(k in task)) errors.push(`missing required field ${k}`);
  for (const k of Object.keys(task)) {
    if (FORBIDDEN_KEYS.includes(k)) errors.push(`${k} is not allowed: a task is natural-language input for the Agent, and never names commands, paths or expected verdicts`);
    else if (!required.includes(k)) errors.push(`unknown field ${k}`);
  }
  if (errors.length) return errors;
  if (strict) errors.push(...validateSingleAction(task));
  if (task.schema_version !== TASK_SCHEMA_VERSION) errors.push(`schema_version must be ${TASK_SCHEMA_VERSION}`);
  if (typeof task.task_id !== 'string' || !TASK_ID.test(task.task_id)) errors.push('task_id must be 3-64 lowercase letters, digits or hyphens, starting with a letter or digit');
  if (!Number.isInteger(task.version) || task.version < 1) errors.push('version must be a whole number of at least 1');
  if (typeof task.title !== 'string' || task.title.trim().length < 3 || task.title.length > 120) errors.push('title must be 3-120 characters');
  if (typeof task.description !== 'string' || task.description.trim().length < 10 || task.description.length > 500) errors.push('description must be 10-500 characters');
  if (typeof task.category !== 'string' || !SLUG.test(task.category)) errors.push('category must be a category id (lowercase letters, digits, hyphens)');
  else if (categories && !categories.has(task.category)) errors.push(`category ${task.category} is not defined in catalog.json`);
  if (typeof task.task_text !== 'string' || task.task_text.trim().length < 20 || task.task_text.length > 2000) errors.push('task_text must be 20-2000 characters of natural language');
  else for (const [re, what] of TEXT_RULES) if (re.test(task.task_text)) errors.push(`task_text contains ${what}; write plain natural language for the Agent`);
  for (const f of ['title', 'description', 'safety_notes']) {
    const text = f === 'safety_notes' ? (Array.isArray(task[f]) ? task[f].join(' ') : '') : String(task[f]);
    if (/\b(?:ALLOW|ALLOWED|DENY|DENIED)\b/.test(text)) errors.push(`${f} states an expected verdict; labels come only from OpenShell events`);
  }
  if (!strings(task.tags, { max: 12, maxLen: 40 }) || new Set(task.tags).size !== task.tags.length || !task.tags.every(t => SLUG.test(t))) errors.push('tags must be up to 12 unique lowercase slugs');
  if (!Array.isArray(task.expected_capabilities) || !task.expected_capabilities.length || !task.expected_capabilities.every(c => CAPABILITIES.includes(c)) || new Set(task.expected_capabilities).size !== task.expected_capabilities.length) errors.push(`expected_capabilities must be a non-empty list of unique values from: ${CAPABILITIES.join(', ')}`);
  if (!DEPENDENCY_MODES.includes(task.external_dependency)) errors.push(`external_dependency must be one of: ${DEPENDENCY_MODES.join(', ')}`);
  if (typeof task.estimated_minutes !== 'number' || !(task.estimated_minutes > 0 && task.estimated_minutes <= 60)) errors.push('estimated_minutes must be a number above 0 and at most 60');
  if (typeof task.enabled !== 'boolean') errors.push('enabled must be true or false');
  if (typeof task.deprecated !== 'boolean') errors.push('deprecated must be true or false');
  if (!strings(task.safety_notes, { max: 10, maxLen: 300 })) errors.push('safety_notes must be a list of up to 10 short strings');
  return errors;
}

const within = (base, file) => { const b = resolve(base) + sep, f = resolve(file); return f.startsWith(b); };
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// Reads safety-router-dataset/task-catalog/. Nothing is executed and nothing outside the folder is read. Returns every task found (valid or not), the problems,
// and the selectable tasks: enabled, not deprecated, valid, in deterministic order (category order, then task id).
export function loadCatalog(root = defaultRoot) {
  const base = tasksDir(root);
  const errors = [], warnings = [];
  const out = { root: base, categories: [], tasks: [], selectable: [], registry: {}, errors, warnings, ok: false };
  const catalogFile = resolve(base, 'catalog.json');
  if (!existsSync(catalogFile)) { errors.push('safety-router-dataset/task-catalog/catalog.json is missing'); return out; }
  let catalog;
  try { catalog = readJson(catalogFile); } catch (e) { errors.push(`catalog.json is not valid JSON: ${e.message}`); return out; }
  if (!isObject(catalog) || catalog.schema_version !== 1 || !Array.isArray(catalog.categories)) { errors.push('catalog.json needs schema_version 1 and a categories list'); return out; }
  const activeType = catalog.active_task_type ?? null;
  if (activeType !== null && activeType !== SINGLE_ACTION_TASK_TYPE) { errors.push(`active_task_type must be ${SINGLE_ACTION_TASK_TYPE}`); return out; }
  out.active_task_type = activeType;
  const cats = [];
  for (const c of catalog.categories) {
    if (!isObject(c) || !SLUG.test(String(c.id)) || typeof c.title !== 'string' || !c.title.trim() || !Number.isInteger(c.order)) { errors.push(`invalid category entry ${JSON.stringify(c).slice(0, 80)}: it needs id, title and an integer order`); continue; }
    if (cats.some(x => x.id === c.id)) { errors.push(`duplicate category id ${c.id}`); continue; }
    cats.push({ id: c.id, title: c.title, description: typeof c.description === 'string' ? c.description : '', order: c.order });
  }
  cats.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  out.categories = cats; out.registry = isObject(catalog.registry) ? catalog.registry : {};
  const known = new Set(cats.map(c => c.id));
  // Each category is a folder directly inside the catalog folder; catalog.json and README.md beside them are not categories.
  const catDir = base;
  const tasks = [];
  const folders = readdirSync(catDir, { withFileTypes: true }).filter(e => !(e.isFile() && ['catalog.json', 'README.md'].includes(e.name)));
  for (const entry of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = resolve(catDir, entry.name);
    if (!within(catDir, folder) || lstatSync(folder).isSymbolicLink()) { errors.push(`${entry.name}: links are not followed`); continue; }
    if (!entry.isDirectory()) { warnings.push(`${entry.name} is not a folder and is ignored`); continue; }
    if (!known.has(entry.name)) { errors.push(`${entry.name} is not a category defined in catalog.json`); }
    for (const f of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(folder, f.name), rel = `${entry.name}/${f.name}`;
      if (!within(folder, file) || lstatSync(file).isSymbolicLink()) { errors.push(`${rel}: links are not followed`); continue; }
      if (!f.isFile()) { warnings.push(`${rel} is not a file and is ignored`); continue; }
      if (!f.name.endsWith('.json')) { if (f.name !== 'README.md') warnings.push(`${rel} is not a task file (.json) and is ignored`); continue; }
      let task;
      try { task = readJson(file); } catch (e) { errors.push(`${rel}: not valid JSON (${e.message})`); continue; }
      const problems = validateTask(task, known, { singleAction: activeType === SINGLE_ACTION_TASK_TYPE });
      if (!problems.length && task.category !== entry.name) problems.push(`category ${task.category} does not match its folder ${entry.name}`);
      for (const p of problems) errors.push(`${rel}: ${p}`);
      if (!problems.length) tasks.push({ ...task, hash: taskHash(task), file: rel });
    }
  }
  // task ids are unique across the whole catalog
  const seen = new Map();
  for (const t of tasks) { if (seen.has(t.task_id)) errors.push(`duplicate task_id ${t.task_id}: ${seen.get(t.task_id)} and ${t.file}`); else seen.set(t.task_id, t.file); }
  const dup = new Set(tasks.map(t => t.task_id).filter((id, i, a) => a.indexOf(id) !== i));
  const rank = new Map(cats.map((c, i) => [c.id, i]));
  const ordered = tasks.filter(t => !dup.has(t.task_id)).sort((a, b) => rank.get(a.category) - rank.get(b.category) || a.task_id.localeCompare(b.task_id));

  // A task id is never reused for different content: the registry remembers each id's version and hash.
  for (const t of ordered) {
    const r = out.registry[t.task_id];
    if (!r) { warnings.push(`${t.task_id}: not in the registry yet (run node safety-router-dataset/collect-data/validate-task-catalog.mjs --update-registry)`); continue; }
    if (t.version < r.version) errors.push(`${t.task_id}: version ${t.version} is lower than the registered version ${r.version}`);
    else if (t.version === r.version && t.hash !== r.hash) errors.push(`${t.task_id}: the task changed but its version is still ${t.version}; increase version when you change what the Agent is asked to do`);
    else if (t.version > r.version) warnings.push(`${t.task_id}: version ${t.version} is newer than the registered ${r.version} (run node safety-router-dataset/collect-data/validate-task-catalog.mjs --update-registry)`);
    else if ((r.history || []).some(h => h.version === t.version && h.hash !== t.hash)) errors.push(`${t.task_id}: version ${t.version} was used before with different content`);
  }
  const ids = new Set(ordered.map(t => t.task_id));
  for (const id of Object.keys(out.registry)) if (!ids.has(id) && !dup.has(id)) warnings.push(`${id} is in the registry but has no task file (its id stays reserved and must not be reused for different content)`);
  out.tasks = ordered;
  out.selectable = ordered.filter(t => t.enabled && !t.deprecated);
  out.ok = errors.length === 0;
  return out;
}

// The selectable tasks of the given categories, grouped for menus. Empty categories are kept so a menu can say so.
export function byCategory(catalog) {
  return catalog.categories.map(c => ({ ...c, tasks: catalog.selectable.filter(t => t.category === c.id) }));
}
// One hash for what a collection will ask: task ids, versions and hashes, in order. A preview is bound to it.
export const catalogHash = tasks => sha256(canonicalJson(tasks.map(t => [t.task_id, t.version, taskHash(t)])));

// Records every task's current version and hash in catalog.json. A new version appends to the id's history; nothing is ever removed, so an id
// keeps its record even after its file is deleted. It refuses while the catalog has any error.
export function updateRegistry(root = defaultRoot) {
  const cat = loadCatalog(root);
  if (cat.errors.length) throw Error('The catalog has errors; fix them first:\n' + cat.errors.join('\n'));
  const file = resolve(tasksDir(root), 'catalog.json');
  const catalog = readJson(file);
  const registry = { ...(catalog.registry || {}) };
  const changed = [];
  for (const t of cat.tasks) {
    const prev = registry[t.task_id];
    if (prev && prev.version === t.version && prev.hash === t.hash) continue;
    if (prev && prev.version === t.version) continue;   // same version, different content: validation already reported it
    registry[t.task_id] = { version: t.version, hash: t.hash, history: [...(prev?.history || []), { version: t.version, hash: t.hash }] };
    changed.push(t.task_id);
  }
  catalog.registry = Object.fromEntries(Object.keys(registry).sort().map(k => [k, registry[k]]));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n');
  renameSync(tmp, file);
  return { changed, total: Object.keys(catalog.registry).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cat = loadCatalog();
  console.log(`${cat.selectable.length} selectable task(s) in ${cat.categories.length} categories; ${cat.errors.length} error(s)`);
}
