// What a collection asks for, and how many executions that makes. Pure functions: parsing the numbers a person types, turning the choices
// into one exact selection, and calculating the executions. Nothing here touches the system.
//
//   Selected Tasks x Selected Policies x Separate Runs = Total Executions
import { canonicalJson, sha256 } from '../../tools/events-panel/provenance.mjs';

export const POLICIES = [
  { id: 'restricted', label: 'Restricted' },
  { id: 'balanced', label: 'Balanced — NemoClaw default' },
  { id: 'open', label: 'Open' },
];
export const POLICY_IDS = POLICIES.map(p => p.id);
// Each separate run is a full sandbox lifecycle (about 1.5 minutes and 1 GB transient). 20 per task and policy keeps one collection to a size a
// person can review; run the collection again for more.
export const RUNS_MIN = 1, RUNS_MAX = 20, RUNS_DEFAULT = 1;
const MAX_INPUT = 200;

export class InputError extends Error {}
const clean = text => String(text ?? '').trim();

// "1", "1,3,5", "1-10", "1-5,12,20-25" -> sorted unique numbers within 1..max. "0" means everything. Anything else is rejected whole.
export function parseNumberList(text, max, { what = 'choice' } = {}) {
  const s = clean(text);
  if (!s) throw new InputError(`Enter a number, a list such as 1,3,5, a range such as 1-10, or 0 for all.`);
  if (s.length > MAX_INPUT) throw new InputError('That input is too long.');
  if (s === '0') return { all: true, numbers: [] };
  if (!/^[0-9]+(?:-[0-9]+)?(?:\s*,\s*[0-9]+(?:-[0-9]+)?)*$/.test(s)) throw new InputError(`"${s.slice(0, 40)}" is not a valid ${what}. Use numbers, commas and ranges only, for example 1,3,5 or 1-10 or 1-5,12,20-25, or 0 for all.`);
  const out = new Set();
  for (const part of s.split(',').map(p => p.trim())) {
    const [a, b = a] = part.split('-').map(Number);
    if (a === 0 || b === 0) throw new InputError('0 means "all" and cannot be combined with other numbers.');
    if (a > b) throw new InputError(`The range ${part} runs backwards.`);
    if (b > max) throw new InputError(`${b} is not available: choose from 1 to ${max}.`);
    for (let n = a; n <= b; n++) out.add(n);
  }
  return { all: false, numbers: [...out].sort((x, y) => x - y) };
}

// [1/5] SELECT POLICIES: 1 Restricted, 2 Balanced, 3 Open, 4 all three.
export function parsePolicyChoice(text) {
  const s = clean(text);
  if (!/^[1-4]$/.test(s)) throw new InputError('Enter 1, 2, 3 or 4.');
  return s === '4' ? [...POLICY_IDS] : [POLICY_IDS[Number(s) - 1]];
}

// [2/5] categories: `categories` are the ones with at least one selectable task. 0 selects them all.
export function parseCategoryChoice(text, categories) {
  if (!categories.length) throw new InputError('There is no category with an enabled task.');
  const r = parseNumberList(text, categories.length, { what: 'category choice' });
  return r.all ? categories.map(c => c.id) : r.numbers.map(n => categories[n - 1].id);
}

// [3/5] tasks: numbered across the selected categories. 0 selects every one of them: no limit is asked and none is applied.
export function parseTaskChoice(text, tasks) {
  if (!tasks.length) throw new InputError('There is no task to choose from.');
  const r = parseNumberList(text, tasks.length, { what: 'task choice' });
  return r.all ? tasks.map(t => t.task_id) : r.numbers.map(n => tasks[n - 1].task_id);
}

// [4/5] the number of separate runs is typed directly; Enter means 1.
export function parseRuns(text) {
  const s = clean(text);
  if (s === '') return RUNS_DEFAULT;
  if (!/^[0-9]{1,4}$/.test(s)) throw new InputError(`Enter a whole number from ${RUNS_MIN} to ${RUNS_MAX}, or press Enter for ${RUNS_DEFAULT}.`);
  const n = Number(s);
  if (n < RUNS_MIN || n > RUNS_MAX) throw new InputError(`The number of separate runs must be from ${RUNS_MIN} to ${RUNS_MAX}.`);
  return n;
}

// The exact selection. Policies, categories and tasks are validated against the catalog and put in catalog order, so the same choices always
// give the same selection (and the same hash). Each task carries its version and hash as they are now: a preview is bound to them.
export function buildSelection({ policies, categories, taskIds, runs }, catalog) {
  if (!Array.isArray(policies) || !policies.length || !policies.every(p => POLICY_IDS.includes(p)) || new Set(policies).size !== policies.length) throw new InputError('Choose Restricted, Balanced, Open or all three.');
  if (!Number.isInteger(runs) || runs < RUNS_MIN || runs > RUNS_MAX) throw new InputError(`The number of separate runs must be from ${RUNS_MIN} to ${RUNS_MAX}.`);
  if (!Array.isArray(categories) || !categories.length) throw new InputError('Choose at least one category.');
  const catIds = new Set(catalog.categories.map(c => c.id));
  for (const c of categories) if (!catIds.has(c)) throw new InputError(`Unknown category ${String(c).slice(0, 40)}.`);
  const wantCats = new Set(categories);
  const pool = catalog.selectable.filter(t => wantCats.has(t.category));
  const byId = new Map(pool.map(t => [t.task_id, t]));
  if (!Array.isArray(taskIds) || !taskIds.length) throw new InputError('Choose at least one task.');
  for (const id of taskIds) if (!byId.has(id)) throw new InputError(`Task ${String(id).slice(0, 60)} is not an enabled task of the selected categories.`);
  const chosen = new Set(taskIds);
  const tasks = pool.filter(t => chosen.has(t.task_id)).map(t => ({ task_id: t.task_id, task_version: t.version, task_hash: t.hash, category: t.category }));
  return {
    policies: POLICY_IDS.filter(p => policies.includes(p)),
    categories: catalog.categories.filter(c => wantCats.has(c.id)).map(c => c.id),
    tasks, runs,
    all_tasks_in_categories: tasks.length === pool.length,
  };
}
export const selectionHash = selection => sha256(canonicalJson(selection));

// Selected Tasks x Selected Policies x Separate Runs = Total Executions, and how they spread.
export function calculate(selection) {
  const t = selection.tasks.length, p = selection.policies.length, r = selection.runs;
  const total = t * p * r;
  const byCategory = {};
  for (const task of selection.tasks) byCategory[task.category] = (byCategory[task.category] || 0) + p * r;
  return {
    selected_tasks: t, selected_policies: p, separate_runs: r, total_executions: total,
    conversations: total, sandboxes: total, expected_bundles: total,
    by_policy: Object.fromEntries(selection.policies.map(id => [id, t * r])),
    by_category: Object.fromEntries(selection.categories.map(id => [id, byCategory[id] || 0])),
    tasks_by_category: Object.fromEntries(selection.categories.map(id => [id, selection.tasks.filter(x => x.category === id).length])),
  };
}

const pad = (n, w = 5) => String(n).padStart(w, '0');
// Every execution has its own id. Order: task, then policy, then separate run, so a run that stops resumes in a predictable place.
export function planExecutions(selection, runId) {
  const out = [];
  let index = 0;
  selection.tasks.forEach((task, ti) => selection.policies.forEach((policy, pi) => {
    for (let run = 1; run <= selection.runs; run++) {
      index++;
      out.push({ execution_id: `${runId}-e${pad(index)}`, index, task_number: ti + 1, policy_number: pi + 1, separate_run: run, ...task, policy });
    }
  }));
  return out;
}

// The text shown for the final calculation.
export function formatCalculation(c) {
  const w = String(c.total_executions).length;
  const row = (n, text) => `  ${String(n).padStart(w)} ${text}`;
  return [
    row(c.selected_tasks, `Selected Task${c.selected_tasks === 1 ? '' : 's'}`),
    `× ${String(c.selected_policies).padStart(w)} ${c.selected_policies === 1 ? 'Policy' : 'Policies'}`,
    `× ${String(c.separate_runs).padStart(w)} Separate Run${c.separate_runs === 1 ? '' : 's'}`,
    `  ${'-'.repeat(w + 16)}`,
    `= ${String(c.total_executions).padStart(w)} Total Executions`,
  ].join('\n');
}
