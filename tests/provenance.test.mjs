import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPolicy, canonicalPolicyHash, reproducibilityDeclaration, canonicalJson, bundleEvidence, sourceHash, EXPERIMENT_MODES } from '../tools/events-panel/provenance.mjs';
import { testTmp } from './tmp-dir.mjs';

test('every collection is an autonomous Agent task', () => {
  assert.deepEqual(EXPERIMENT_MODES, ['autonomous_agent']);
});

test('dynamic provider ids normalize and do not change anything else', () => {
  const make = id => ({ version: 3, network_policies: { [`_provider_nemoclaw_local_v1_${id}`]: { name: `_provider_nemoclaw_local_v1_${id}`, endpoints: [{ host: 'host.openshell.internal' }] }, pypi: { name: 'pypi' } } });
  const a = make('08aa180fbcb9e209b0c811f0'), b = make('ffffffffffffffffffffffff');
  assert.equal(canonicalPolicyHash(a), canonicalPolicyHash(b));
  assert.deepEqual(Object.keys(canonicalPolicy(a).network_policies), ['_provider_nemoclaw_local_v1_SANDBOX', 'pypi']);
  assert.equal(canonicalPolicy(a).network_policies.pypi.name, 'pypi');
  assert.notEqual(canonicalPolicyHash(a), canonicalPolicyHash({ ...a, version: 4 }));
  // deterministic: key order of the input does not matter
  assert.equal(canonicalPolicyHash({ b: 1, a: 2 }), canonicalPolicyHash({ a: 2, b: 1 }));
});

test('canonicalizing leaves the original object untouched', () => {
  const p = { network_policies: { '_provider_x_v1_0123456789abcdef': { a: 1 } } };
  const before = JSON.stringify(p);
  canonicalPolicy(p);
  assert.equal(JSON.stringify(p), before);
});

test('two rules that would collapse into one name are refused', () => {
  assert.throws(() => canonicalPolicy({ '_provider_x_v1_0123456789abcdef': 1, '_provider_x_v1_fedcba9876543210': 2 }), /same name/);
});

const fullEnv = { pins_sha256: 'x', versions: { nemoclaw: '0.0.140' }, reproducibility: { ollama_model_digest: 'a'.repeat(64), runtime_image_id: 'sha256:x', wsl_kernel: '6.6', project_source: { kind: 'source_hash', value: 'v' } } };

test('reproducibility claims need evidence, and the Agent\'s behavior is never claimed exact', () => {
  assert.deepEqual(reproducibilityDeclaration({ environment: fullEnv, derivable: true }), { environment: true, dataset_derivation: true, exact_agent_behavior: false });
  // a short model id is not a digest; missing evidence leaves the claim false
  assert.equal(reproducibilityDeclaration({ environment: { ...fullEnv, reproducibility: { ...fullEnv.reproducibility, ollama_model_digest: '65ec06548149' } }, derivable: true }).environment, false);
  assert.equal(reproducibilityDeclaration({ environment: null, derivable: false }).dataset_derivation, false);
  assert.equal(reproducibilityDeclaration({ environment: fullEnv, derivable: true }).exact_agent_behavior, false);
});

test('bundle evidence lists what is missing', () => {
  const dir = testTmp('ev-');
  try {
    assert.equal(bundleEvidence(dir).complete, false);
    for (const f of ['manifest.json', 'task.json', 'tool-calls.jsonl', 'conversation.json', 'environment.json', 'effective-policy.json', 'openshell-log-sanitized.txt', 'openshell-events.jsonl']) writeFileSync(join(dir, f), '');
    mkdirSync(join(dir, 'trajectory')); writeFileSync(join(dir, 'trajectory/events.jsonl'), ''); mkdirSync(join(dir, 'policy-versions'));
    assert.equal(bundleEvidence(dir).complete, true);
    assert.deepEqual(bundleEvidence(dir, { ignore: ['manifest.json'] }).missing, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source hash ignores line endings and changes with content', () => {
  const dir = testTmp('src-');
  try {
    writeFileSync(join(dir, 'a.txt'), 'x\r\ny\r\n'); const h1 = sourceHash(dir, ['a.txt']);
    writeFileSync(join(dir, 'a.txt'), 'x\ny\n'); assert.equal(sourceHash(dir, ['a.txt']), h1);
    writeFileSync(join(dir, 'a.txt'), 'x\nz\n'); assert.notEqual(sourceHash(dir, ['a.txt']), h1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(canonicalJson({ b: [2, { d: 1, c: 2 }], a: 1 }), '{"a":1,"b":[2,{"c":2,"d":1}]}');
});
