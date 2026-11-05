// Generate Dataset.cmd: the numbered menu of the Safety Router data collector. It asks, previews, and starts only after RUN is typed.
// The terminal and the system come in through `io` and `ctx`, so the whole dialogue is tested with scripted answers and mocks.
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { loadCatalog, byCategory } from './task-catalog.mjs';
import { main as validateTasksMain } from './validate-task-catalog.mjs';
import { InputError, POLICIES, RUNS_MAX, RUNS_MIN, RUNS_DEFAULT, parsePolicyChoice, parseCategoryChoice, parseTaskChoice, parseRuns, parseNumberList, buildSelection, calculate, formatCalculation } from './collection-selection.mjs';
import { createPreview, startCollection, listResumable, resumePlan, formatPreview, formatReport, requestCancel } from './collection-runner.mjs';
import { ProgressRenderer } from './progress-display.mjs';

const RULE = '='.repeat(60);
const MAX_TRIES = 5;
export const MENU = [
  RULE, ' NemoClaw Safety Router Data Collector', RULE, '',
  '1) Start a new collection of Single-Action Policy Tests', '2) Resume a previous collection', '3) Validate the task catalog', '0) Exit', '',
].join('\n');

// Asks until the answer parses; a malformed answer is explained and asked again, and nothing is created meanwhile.
async function askValid(io, prompt, parse) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const answer = await io.ask(prompt);
    if (answer === null) throw new InputError('Input ended.');
    try { return parse(answer); } catch (e) { if (!(e instanceof InputError)) throw e; io.print(`  ${e.message}\n`); }
  }
  throw new InputError('Too many invalid answers. Nothing was created.');
}

async function confirmAndRun(ctx, io, selection, { resume = null } = {}) {
  const preview = await createPreview(ctx, selection, { resume });
  io.print(`\n${formatPreview(preview, { catalog: ctx.catalog() })}\n`);
  if (!preview.can_start) { io.print('\nThis selection cannot start. Fix the blockers above and try again. Nothing was created.\n'); return 2; }
  io.print(`\n${formatCalculation(preview.calculation)}\n`);
  const typed = await io.ask('\nType RUN (exactly) to start. Anything else cancels and creates nothing: ');
  if (typed !== 'RUN') { io.print('Cancelled. No Conversation or Sandbox was created.\n'); return 2; }
  const renderer = new ProgressRenderer({ stream: io.stream, tty: io.tty, columns: io.columns });
  ctx.onUpdate = state => renderer.update(state);
  io.print('\n');
  try {
    const state = await startCollection(ctx, { previewId: preview.preview_id, confirmation: 'RUN', selection, resumeRunId: resume?.run_id ?? null });
    renderer.finish(state);
    io.print(`\n${formatReport(state.report)}\n`);
    return state.status === 'succeeded' ? 0 : 1;
  } catch (e) { io.print(`\nNot started: ${e.message}\n`); return 2; }
  finally { ctx.onUpdate = null; }
}

async function newCollection(ctx, io) {
  const catalog = ctx.catalog();
  if (!catalog.ok) { io.print(`The task catalog has errors; fix them first (option 3):\n${catalog.errors.slice(0, 5).map(e => `  ${e}`).join('\n')}\n`); return 2; }
  const cats = byCategory(catalog).filter(c => c.tasks.length);
  if (!cats.length) { io.print('No category has an enabled task.\n'); return 2; }
  try {
    io.print('\n[1/4] SELECT POLICIES\n\n');
    POLICIES.forEach((p, i) => io.print(`  ${i + 1}) ${p.label}\n`));
    io.print(`  ${POLICIES.length + 1}) All three policies\n\n`);
    const policies = await askValid(io, 'Choose 1-4: ', parsePolicyChoice);
    io.print(`Selected policies: ${policies.map(id => POLICIES.find(p => p.id === id).label).join(', ')}\n`);
    if (policies.length > 1) io.print('\nEvery policy execution is independent.\nThe Agent may choose different tools or commands under different\npolicies. This measures real Agent behavior under each policy;\nit does not prove that policy is the only variable.\n');

    // One category only: Single-Action Policy Tests. There is nothing to choose, so the step is not asked.
    const chosenCats = cats;
    const categoryIds = cats.map(c => c.id);

    io.print('\n[2/4] SELECT SINGLE-ACTION POLICY TESTS\n\nEach test asks the Agent for exactly one tool call, once, against one destination.\n\n');
    const pool = chosenCats.flatMap(c => c.tasks);
    pool.forEach((t, i) => io.print(`  ${String(i + 1).padStart(3)}) ${t.title}   [${t.task_id}]\n       ${t.single_action ? `${t.single_action.tool} ${t.single_action.arguments.url}` : ''}\n`));
    io.print('    0) All tests\n\n');
    const taskIds = await askValid(io, 'Choose tests (for example 1  or 1,3,5  or 1-4, or 0 for all): ', t => parseTaskChoice(t, pool));
    const selection0 = buildSelection({ policies, categories: categoryIds, taskIds, runs: RUNS_DEFAULT }, catalog);
    const byCat = selection0.categories.map(id => `  ${(chosenCats.find(c => c.id === id)?.title) ?? id}: ${selection0.tasks.filter(t => t.category === id).length}`).join('\n');
    io.print(`Selected Tasks: ${selection0.tasks.length}\n${byCat}\n`);

    io.print('\n[3/4] SELECT INDEPENDENT EXECUTIONS\n\nHow many independent executions of each test under each policy?\n\nEvery separate run starts with:\n  - A new Conversation\n  - A new isolated Sandbox\n  - A new Agent session\n  - New OpenShell event collection\n  - No state from an earlier run\n\n');
    io.print(`Enter the number of independent executions per test and policy (${RUNS_MIN} to ${RUNS_MAX}).\n\nPress Enter to use the default value of ${RUNS_DEFAULT}.\n\n`);
    const runs = await askValid(io, `Number of independent executions [default: ${RUNS_DEFAULT}]: `, parseRuns);
    const selection = buildSelection({ policies, categories: categoryIds, taskIds, runs }, catalog);
    io.print(`\nIndependent executions per test and policy:\n  ${runs}\n`);

    io.print('\n[4/4] REVIEW AND CONFIRM\n');
    return await confirmAndRun(ctx, io, selection);
  } catch (e) { if (e instanceof InputError) { io.print(`${e.message}\n`); return 2; } throw e; }
}

async function resumeCollection(ctx, io) {
  const runs = listResumable(ctx);
  if (!runs.length) { io.print('There is no failed, cancelled or interrupted collection to resume.\n'); return 0; }
  io.print('\nCollections that can be resumed:\n\n');
  runs.forEach((r, i) => io.print(`  ${i + 1}) ${r.run_id}  ${r.status}  ${r.completed}/${r.total} executions complete\n`));
  io.print('  0) Back\n\n');
  try {
    const pick = await askValid(io, `Choose 0-${runs.length}: `, t => { const r = parseNumberList(t, runs.length, { what: 'collection choice' }); if (!r.all && r.numbers.length !== 1) throw new InputError('Choose one collection.'); return r; });
    if (pick.all) return 0;
    const run = runs[pick.numbers[0] - 1];
    const plan = resumePlan(ctx, run.run_id);
    io.print(`\nCollection ${run.run_id} (${plan.state.status}):\n  completed and verified: ${plan.completed}\n  remaining: ${plan.remaining} of ${plan.total}\n`);
    if (plan.catalog_changed.length) { io.print(`\nThese tasks changed since the collection started, so it cannot be resumed:\n  ${plan.catalog_changed.join('\n  ')}\nStart a new collection instead.\n`); return 2; }
    if (!plan.remaining) { io.print('Nothing remains to run.\n'); return 0; }
    return await confirmAndRun(ctx, io, plan.selection, { resume: plan.state });
  } catch (e) { if (e instanceof InputError) { io.print(`${e.message}\n`); return 2; } throw e; }
}

// The menu loop. Returns the exit code of the last action that could fail.
export async function main({ ctx, io }) {
  let code = 0;
  io.print(`${MENU}\n`);
  for (let tries = 0; ; ) {
    const choice = (await io.ask('Choose 0-3: '));
    if (choice === null) return code;
    const c = String(choice).trim();
    if (!/^[0-3]$/.test(c)) { io.print('  Enter a number from 0 to 3.\n'); if (++tries >= MAX_TRIES * 2) { io.print('Too many invalid answers. Nothing was created.\n'); return 2; } continue; }
    tries = 0;
    if (c === '0') return code;
    if (c === '1') code = await newCollection(ctx, io);
    else if (c === '2') code = await resumeCollection(ctx, io);
    else if (c === '3') { io.print('\nValidating the task catalog\n'); const logLines = []; const log = console.log, err = console.error; console.log = (...a) => logLines.push(a.join(' ')); console.error = (...a) => logLines.push(a.join(' ')); try { code = validateTasksMain(['--list'], ctx.root); } finally { console.log = log; console.error = err; } io.print(`${logLines.slice(-40).join('\n')}\n`); }
    io.print(`\n${MENU}\n`);
  }
}

// The real terminal.
function realIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let ended = false; rl.on('close', () => { ended = true; });
  const queue = []; let waiting = null;
  rl.on('line', line => { if (waiting) { const w = waiting; waiting = null; w(line); } else queue.push(line); });
  rl.on('close', () => { if (waiting) { const w = waiting; waiting = null; w(null); } });
  return {
    stream: process.stdout, tty: Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb', columns: process.stdout.columns || 100,
    print: text => process.stdout.write(text),
    ask: prompt => new Promise(res => { process.stdout.write(prompt); if (queue.length) res(queue.shift()); else if (ended) res(null); else waiting = res; }),
    close: () => rl.close(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { makeContext } = await import('./system-adapter.mjs');
  const { projectRoot } = await import('./task-catalog.mjs').then(m => ({ projectRoot: m.defaultRoot }));
  const ctx = makeContext({ root: projectRoot });
  const io = realIo();
  // Ctrl+C asks for a stop between executions; it never interrupts evidence saving.
  let pressed = false;
  process.on('SIGINT', () => {
    if (pressed) { io.print('\nA stop is already requested; the running execution is being finished safely.\n'); return; }
    pressed = true;
    try { io.print(`\n${requestCancel(ctx).note}\n`); } catch { io.print('\nNothing is running.\n'); io.close(); process.exit(130); }
  });
  const code = await main({ ctx, io });
  io.close();
  process.exit(code);
}
