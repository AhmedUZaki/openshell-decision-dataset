// Validates the task catalog in safety-router-dataset/task-catalog/.
//   node safety-router-dataset/collect-data/validate-task-catalog.mjs                     checks every task file; exit code 1 on any error
//   node safety-router-dataset/collect-data/validate-task-catalog.mjs --update-registry   records the current version and hash of every task in catalog.json (after you changed or added tasks)
//   node safety-router-dataset/collect-data/validate-task-catalog.mjs --list             prints the selectable tasks by category
// It only reads task files. Nothing is executed.
import { pathToFileURL } from 'node:url';
import { loadCatalog, byCategory, updateRegistry } from './task-catalog.mjs';

export function main(argv, root) {
  const unknown = argv.filter(a => !['--update-registry', '--list', '--json'].includes(a));
  if (unknown.length) { console.error(`Unknown option ${unknown[0]}`); return 2; }
  if (argv.includes('--update-registry')) {
    try { const r = updateRegistry(root); console.log(`Registry updated: ${r.changed.length} task(s) recorded or revised, ${r.total} in the registry.${r.changed.length ? `\n  ${r.changed.join('\n  ')}` : ''}`); }
    catch (e) { console.error(e.message); return 1; }
  }
  const cat = loadCatalog(root);
  if (argv.includes('--json')) { console.log(JSON.stringify({ ok: cat.ok, errors: cat.errors, warnings: cat.warnings, selectable: cat.selectable.length, tasks: cat.tasks.length })); return cat.ok ? 0 : 1; }
  if (argv.includes('--list')) for (const c of byCategory(cat)) { console.log(`${c.title} (${c.id}): ${c.tasks.length} task(s)`); for (const t of c.tasks) console.log(`  ${t.task_id}  v${t.version}  ${t.hash.slice(0, 12)}  ${t.title}`); }
  console.log(`${cat.tasks.length} task file(s) read, ${cat.selectable.length} selectable (enabled and not deprecated), ${cat.categories.length} categories.`);
  for (const w of cat.warnings) console.log(`WARNING: ${w}`);
  for (const e of cat.errors) console.error(`ERROR: ${e}`);
  console.log(cat.ok ? 'The task catalog is valid.' : `The task catalog has ${cat.errors.length} error(s).`);
  return cat.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
