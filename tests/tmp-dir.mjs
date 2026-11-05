// Every temporary directory of every test is created here, under <project>/.local/test-tmp/, and nowhere else. A path is resolved to an absolute path and
// must be strictly inside that folder before anything is created or removed: the project root, `.local` itself, the test-tmp folder itself and any path
// outside it are refused. No test keeps saved evidence, Bundles, Runs, Captures, Dataset outputs or GUI/panel state here.
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_TMP = resolve(projectRoot, '.local', 'test-tmp');
const created = new Set();

// True only for an absolute path strictly inside .local/test-tmp/.
export function insideTestTmp(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  const rel = relative(TEST_TMP, resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// A new, unique, empty directory for one test run.
export function testTmp(prefix = 't-') {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(prefix)) throw Error(`unsafe test directory prefix: ${prefix}`);
  mkdirSync(TEST_TMP, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP, `${prefix}${process.pid}-`));
  if (!insideTestTmp(dir)) { rmdirSync(dir); throw Error('the test directory is not inside .local/test-tmp'); }
  created.add(dir);
  return dir;
}

// Removes one test directory after checking its absolute path. Refuses everything that is not strictly inside .local/test-tmp/.
export function removeTestTmp(dir) {
  if (!insideTestTmp(dir)) throw Error(`refusing to remove a path outside .local/test-tmp: ${dir}`);
  rmSync(resolve(dir), { recursive: true, force: true });
  created.delete(dir);
}

// Safety net: a test that failed before its own cleanup still leaves nothing behind. The original failure is never hidden by it.
process.on('exit', () => { for (const dir of [...created]) { try { if (insideTestTmp(dir)) rmSync(resolve(dir), { recursive: true, force: true }); } catch {} } });

// Removes the (empty) test-tmp folder itself; refuses when anything is left in it. Called by the test launcher after every test process has finished.
export function removeTestTmpRootIfEmpty() { if (existsSync(TEST_TMP)) { try { rmdirSync(TEST_TMP); return true; } catch { return false; } } return true; }
