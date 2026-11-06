// What identifies and vouches for a collected execution: the canonical form of a policy and its hash, the external-dependency classes, the
// reproducibility declaration, the check that a bundle has all its evidence, and the source hashes of the code. Pure functions plus helpers that
// read the project tree; nothing here runs a task or contacts a sandbox.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const PROTOCOL_VERSION = 'safety-router-protocol-1.0';
// Every collection is an autonomous Agent task. The field stays in every record as provenance.
export const EXPERIMENT_MODES = ['autonomous_agent'];
// How much of a target the project controls. A live endpoint can change (DNS, certificate, content, rate limits).
export const DEPENDENCY_MODES = ['local_fixture', 'pinned_artifact', 'recorded_replay', 'live_external'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// JSON with object keys sorted at every level; arrays keep their order. Equal values always give equal text.
export function canonicalJson(value) {
  const sort = v => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
    : v;
  return JSON.stringify(sort(value));
}

// ---- Policies -----------------------------------------------------------------------------------------------------------
// NemoClaw composes a per-sandbox rule named _provider_<name>_v<N>_<hex id>; the id differs for every sandbox and means nothing to a
// router. The canonical policy replaces it by a fixed token, in rule names and in text, and sorts keys, so two policies that differ
// only in that id get the same canonical hash. The original policy is kept unchanged as evidence.
const DYNAMIC_ID = /(_provider_[a-z0-9_]+?_v\d+_)[0-9a-f]{8,}/g;
export const CANONICAL_ID_TOKEN = 'SANDBOX';
export const normalizeDynamicIds = text => String(text).replace(DYNAMIC_ID, `$1${CANONICAL_ID_TOKEN}`);

export function canonicalPolicy(policy) {
  const walk = v => {
    if (typeof v === 'string') return normalizeDynamicIds(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) {
        const k = normalizeDynamicIds(key);
        if (k in out) throw Error(`Two rules normalize to the same name (${k}); the policy cannot be canonicalized unambiguously.`);
        out[k] = walk(v[key]);
      }
      return out;
    }
    return v;
  };
  return walk(policy);
}
export const policyHash = policy => sha256(canonicalJson(policy));
export const canonicalPolicyHash = policy => policyHash(canonicalPolicy(policy));

// ---- Reproducibility ----------------------------------------------------------------------------------------------------
// Three claims, each true only when the saved evidence supports it.
//   environment          the saved environment names the exact model digest, runtime image, kernel, pins and source.
//   dataset_derivation   the bundle has everything needed to rebuild and audit the samples (checked by bundleEvidence).
//   exact_agent_behavior never true: an agent's tool calls and wording are not reproducible.
export function reproducibilityDeclaration({ environment, derivable }) {
  const r = environment?.reproducibility ?? {};
  const environmentEvidence = Boolean(/^[0-9a-f]{64}$/.test(r.ollama_model_digest || '') && r.runtime_image_id && r.wsl_kernel && environment?.pins_sha256 && r.project_source?.value && environment?.versions?.nemoclaw);
  return { environment: environmentEvidence, dataset_derivation: Boolean(derivable), exact_agent_behavior: false };
}

// Files a bundle needs for its samples to be rebuilt and audited.
export function bundleEvidence(folder, { ignore = [] } = {}) {
  const need = ['manifest.json', 'task.json', 'tool-calls.jsonl', 'conversation.json', 'environment.json', 'effective-policy.json', 'openshell-log-sanitized.txt', 'openshell-events.jsonl', 'trajectory/events.jsonl'];
  const missing = need.filter(f => !ignore.includes(f) && !existsSync(resolve(folder, f)));
  // A bundle saved with evidence layers (execution.json) is complete only if both layers it names are finalized. Older bundles have neither.
  const executionFile = resolve(folder, 'execution.json');
  if (existsSync(executionFile) && !ignore.includes('execution.json')) {
    try {
      const evidence = JSON.parse(readFileSync(executionFile, 'utf8')).evidence;
      const root = resolve(folder, '..', '..', '..');
      const base = resolve(root, '.local/evidence') + sep;
      for (const dir of [evidence?.raw_dir, evidence?.sanitized_dir]) {
        const full = dir ? resolve(root, dir) : null;
        if (!full || !full.startsWith(base) || !existsSync(resolve(full, 'manifest.json'))) missing.push(`evidence ${dir ?? '(not named)'}`);
      }
    } catch { missing.push('execution.json'); }
  }
  return { complete: missing.length === 0, missing };
}

// ---- Source hashes ------------------------------------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..', '..');
// Line endings are normalized so a checkout with CRLF and one with LF hash the same.
const fileDigest = file => sha256(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
export function sourceHash(root, files) {
  return sha256(files.map(f => `${f}:${existsSync(resolve(root, f)) ? fileDigest(resolve(root, f)) : 'missing'}`).join('\n'));
}
// What produced the dataset files: the code that builds and checks the Single-Action Policy Test records.
export const EXPORTER_FILES = ['tools/events-panel/single-action-record.mjs', 'tools/events-panel/tool-calls.mjs', 'tools/events-panel/openshell-events.mjs', 'tools/events-panel/provenance.mjs', 'safety-router-dataset/create-dataset/schema-validate.mjs', 'safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/validate-single-action-policy-tests.mjs', 'safety-router-dataset/create-dataset/schemas/single-action-policy-test-record.schema.json'];
export const exporterHash = (root = projectRoot) => sourceHash(root, EXPORTER_FILES);

const TEXT = /\.(mjs|js|json|jsonl|ps1|sh|cmd|env|py|txt|md|csv)$/i;
function walk(root, dir, out) {
  for (const name of readdirSync(resolve(root, dir)).sort()) {
    const rel = join(dir, name).replaceAll('\\', '/');
    if (['.local', 'node_modules', '.git'].includes(name)) continue;
    const st = statSync(resolve(root, rel));
    if (st.isDirectory()) walk(root, rel, out); else if (TEXT.test(name)) out.push(rel);
  }
}
// The project's own revision: the Git commit when Git is available and this is a checkout, else a hash of the source files.
export function projectSource(root = projectRoot) {
  try {
    if (existsSync(resolve(root, '.git'))) {
      const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^[0-9a-f]{40}$/.test(head)) return { kind: 'git_commit', value: head };
    }
  } catch { /* fall back to the source hash */ }
  const files = [];
  for (const dir of ['setup', 'tools', 'safety-router-dataset', 'docs']) if (existsSync(resolve(root, dir))) walk(root, dir, files);
  for (const f of ['README.md', 'Install Everything.cmd', 'Start OpenClaw Workspace.cmd', 'Verify Installation.cmd', 'Generate Dataset.cmd']) if (existsSync(resolve(root, f))) files.push(f);
  return { kind: 'source_hash', value: sourceHash(root, files), files: files.length };
}

