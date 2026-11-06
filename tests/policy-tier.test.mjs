// Switching a chat sandbox between NemoClaw's own tiers: the plan is a difference of preset sets, and only tier presets are ever removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTiers, parsePresetList, currentTier, planSwitch, editBlock } from '../tools/events-panel/policy-tier.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIERS_YAML = `tiers:
  - name: restricted
    label: Restricted
    description: Base sandbox only.
    presets: []

  - name: balanced
    label: Balanced
    presets:
      - { name: npm,          access: read-write }
      - { name: pypi,         access: read-write }
      - { name: huggingface,  access: read-write }
      - { name: brew-balanced, access: read-write }
      - { name: brave,        access: read-write }

  - name: open
    label: Open
    presets:
      - { name: npm,          access: read-write }
      - { name: pypi,         access: read-write }
      - { name: huggingface,  access: read-write }
      - { name: brew,         access: read-write }
      - { name: brave,        access: read-write }
      - { name: weather,      access: read }
      - { name: slack,        access: read-write }

  - name: personal
    label: Personal
    presets:
      - { name: personal-open-internet, access: read-write }
`;
const listText = applied => ['npm', 'pypi', 'huggingface', 'brew-balanced', 'brew', 'brave', 'weather', 'slack', 'openclaw-pricing', 'jira']
  .map(n => `    ${applied.includes(n) ? '●' : '○'} ${n}${applied.includes(n) ? ' [user-added]' : ''} — text`).join('\n');
const tiers = parseTiers(TIERS_YAML);

test('tiers.yaml is read into the three selectable tiers; Personal is not offered', () => {
  assert.deepEqual(Object.keys(tiers), ['restricted', 'balanced', 'open']);
  assert.deepEqual(tiers.restricted, []);
  assert.deepEqual(tiers.balanced, ['npm', 'pypi', 'huggingface', 'brew-balanced', 'brave']);
  assert.ok(tiers.open.includes('slack') && !tiers.open.includes('personal-open-internet'));
});

test('a tiers file without the three tiers is refused', () => {
  assert.throws(() => parseTiers('tiers:\n  - name: balanced\n    presets: []\n'), /restricted/);
});

test('the applied presets are read from "policy list"', () => {
  const { applied, known } = parsePresetList(listText(['npm', 'pypi']));
  assert.deepEqual([...applied].sort(), ['npm', 'pypi']);
  assert.ok(known.has('slack') && !applied.has('slack'));
  assert.throws(() => parsePresetList('nothing useful'), /could not be read/);
});

test('the current tier is the tier whose presets are exactly the applied tier presets', () => {
  assert.equal(currentTier(tiers, new Set()), 'restricted');
  assert.equal(currentTier(tiers, new Set(tiers.balanced)), 'balanced');
  assert.equal(currentTier(tiers, new Set(tiers.open)), 'open');
  assert.equal(currentTier(tiers, new Set(['npm'])), null, 'a hand-changed sandbox is custom');
  assert.equal(currentTier(tiers, new Set([...tiers.balanced, 'openclaw-pricing'])), 'balanced', 'a preset outside every tier does not change the tier');
});

test('Balanced to Open adds and removes exactly the difference; presets outside every tier are never removed', () => {
  const state = parsePresetList(listText([...tiers.balanced, 'openclaw-pricing', 'jira']));
  const plan = planSwitch(tiers, state, 'open');
  assert.equal(plan.from, 'balanced');
  assert.deepEqual(plan.add.sort(), ['brew', 'slack', 'weather']);
  assert.deepEqual(plan.remove, ['brew-balanced']);
  assert.ok(!plan.remove.includes('openclaw-pricing') && !plan.remove.includes('jira'));
});

test('Open to Restricted removes every tier preset and nothing else', () => {
  const state = parsePresetList(listText([...tiers.open, 'openclaw-pricing']));
  const plan = planSwitch(tiers, state, 'restricted');
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove.sort(), [...tiers.open].sort());
});

test('switching to the tier already applied changes nothing; an unknown tier or preset is refused', () => {
  const state = parsePresetList(listText(tiers.balanced));
  const plan = planSwitch(tiers, state, 'balanced');
  assert.deepEqual([plan.add, plan.remove], [[], []]);
  assert.throws(() => planSwitch(tiers, state, 'personal'), /restricted, balanced or open/);
  assert.throws(() => planSwitch(tiers, parsePresetList('    ● npm — x\n    ○ pypi — y'), 'open'), /does not list the preset/);
});

test('a dataset collection sandbox cannot be edited; a normal chat and the main chat can', () => {
  assert.match(editBlock({ execution: { run_id: 'r', execution_id: 'e', separate_run: 1 } }), /must stay unchanged/);
  assert.equal(editBlock({ execution: null }), null);
  assert.equal(editBlock(undefined), null);
});

test('the service exposes the switch only as a confirmed POST and records every change', () => {
  const svc = readFileSync(resolve(root, 'tools/events-panel/panel-service.mjs'), 'utf8');
  assert.match(svc, /writeRoutes = \['\/policy\/tier\/set'/);
  assert.match(svc, /readRoutes = \[[^\]]*'\/policy\/tier'/);
  assert.match(svc, /request\.confirm !== true/);
  assert.match(svc, /policy-edits\.jsonl/);
  assert.match(svc, /editBlock\(conversation\)/);
  assert.match(readFileSync(resolve(root, 'tools/events-panel/service-files.txt'), 'utf8'), /policy-tier\.mjs/);
});
