// The standard test command: runs every tests/*.test.mjs with Node's test runner, in filename order, passing the files explicitly.
// It never relies on shell wildcard expansion, so it behaves the same in cmd.exe, PowerShell, bash and npm.
//   node tests/run-tests.mjs            run all tests
//   node tests/run-tests.mjs --list     print the files that would run
// Extra arguments after the options (for example --test-name-pattern=...) go to `node --test`. The exit code is Node's.
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTestTmpRootIfEmpty } from './tmp-dir.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testsDir, '..');

export function discoverTests(dir = testsDir) {
  return readdirSync(dir).filter(n => /\.test\.mjs$/.test(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(n => resolve(dir, n));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const files = discoverTests();
  const args = process.argv.slice(2);
  if (args[0] === '--list') { for (const f of files) console.log(f.slice(root.length + 1).replaceAll('\\', '/')); process.exit(0); }
  if (!files.length) { console.error('No tests/*.test.mjs files were found.'); process.exit(1); }
  const run = spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit' });
  // every test process has finished: the temporary folder (.local/test-tmp, only ever holding test directories) goes too, when it is empty
  removeTestTmpRootIfEmpty();
  process.exit(run.status ?? 1);
}
