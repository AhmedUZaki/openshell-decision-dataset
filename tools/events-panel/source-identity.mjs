// Which files of this project are protected source, and the identity of the project's source at one moment.
//
// The protected set is every file that defines how the dataset is built, checked or collected, or that the installer and launchers run.
// setup/checksums.json lists each one with its SHA-256; Verify Installation and the tests compare the tree with that list. Generated data
// (.local), secrets, evidence, Runs and Captures are never part of it.
//
// project_identity is recorded in every newly saved evidence bundle (environment.json) and in every dataset release manifest:
//   git_commit / git_dirty   from Git when this folder is a Git checkout and Git answers, otherwise null (never guessed)
//   source_manifest_hash     SHA-256 over the sorted "path:sha256" lines of the protected files (always available, deterministic)
// Pure reads. Nothing here runs a task, contacts a sandbox or writes a file.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const MANIFEST_FILE = 'setup/checksums.json';
export const MANIFEST_SCHEMA_VERSION = 2;
export const IDENTITY_SCHEMA_VERSION = 1;

// The rules. They are also written into setup/checksums.json so the PowerShell verifier applies exactly the same ones.
export const PROTECTED_RULES = Object.freeze({
  directories: ['safety-router-dataset', 'setup', 'tools'],
  root_file_patterns: ['*.cmd'],
  root_files: ['package.json'],
  extra_files: ['tests/run-tests.mjs'],
  exclude_files: [MANIFEST_FILE],
  exclude_directories: ['.git', '.local', 'node_modules', '__pycache__'],
  exclude_extensions: ['.pyc', '.log'],
});

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const fileSha256 = file => sha256(readFileSync(file));
const posix = p => p.replaceAll('\\', '/');
const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = resolve(here, '..', '..');

const globToRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');

// Every protected source file under root, as sorted forward-slash relative paths.
export function listProtectedFiles(root = defaultRoot, rules = PROTECTED_RULES) {
  const out = new Set();
  const excludedDir = name => rules.exclude_directories.includes(name);
  const excludedFile = rel => rules.exclude_files.includes(rel) || rules.exclude_extensions.some(e => rel.toLowerCase().endsWith(e));
  const walk = rel => {
    for (const name of readdirSync(resolve(root, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      const st = statSync(resolve(root, child));
      if (st.isDirectory()) { if (!excludedDir(name)) walk(child); } else if (!excludedFile(child)) out.add(child);
    }
  };
  for (const dir of rules.directories) if (existsSync(resolve(root, dir))) walk(dir);
  const patterns = rules.root_file_patterns.map(globToRegExp);
  for (const name of readdirSync(root)) {
    if (!statSync(resolve(root, name)).isFile()) continue;
    if ((patterns.some(p => p.test(name)) || rules.root_files.includes(name)) && !excludedFile(name)) out.add(name);
  }
  for (const f of rules.extra_files) if (existsSync(resolve(root, f))) out.add(f);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// One entry per protected file; the bytes are hashed exactly as stored (.gitattributes keeps them byte-for-byte).
export function buildEntries(root = defaultRoot, rules = PROTECTED_RULES) {
  return listProtectedFiles(root, rules).map(path => ({ path, sha256: fileSha256(resolve(root, path)) }));
}

export const sourceManifestHash = entries => sha256(entries.map(e => `${e.path}:${e.sha256}`).join('\n'));

// What the project source is right now, from the files on disk (not from setup/checksums.json, so a modified file changes it).
function gitState(root) {
  const run = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const state = { git_commit: null, git_dirty: null };
  if (!existsSync(resolve(root, '.git'))) return state;
  try { const head = run(['rev-parse', 'HEAD']).trim(); if (/^[0-9a-f]{40}$/.test(head)) state.git_commit = head; } catch { /* Git missing or no commit yet */ }
  try { state.git_dirty = run(['status', '--porcelain']).trim().length > 0; } catch { /* Git missing */ }
  return state;
}
export function projectIdentity(root = defaultRoot) {
  const entries = buildEntries(root);
  return {
    schema_version: IDENTITY_SCHEMA_VERSION,
    ...gitState(root),
    source_manifest_hash: sourceManifestHash(entries),
    source_manifest_files: entries.length,
    paths: 'repository-relative',
  };
}
