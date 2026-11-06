// Switching a chat sandbox between NemoClaw's own policy tiers. NemoClaw has no "change tier" command: a tier is a list of presets
// (nemoclaw-blueprint/policies/tiers.yaml), so a switch is the difference between the presets that are applied and the presets of the
// target tier, applied with NemoClaw's own `policy add` / `policy remove`. Only presets that belong to a tier are ever removed.
// Nothing here runs a command; the panel service does that.
export const TIER_NAMES = ['restricted', 'balanced', 'open'];
export const TIER_LABELS = { restricted: 'Restricted', balanced: 'Balanced', open: 'Open' };
const PRESET = /^[a-z0-9][a-z0-9-]{0,40}$/;

// tiers.yaml lists each tier as "  - name: <tier>" followed by "      - { name: <preset>, access: ... }" lines.
export function parseTiers(yamlText) {
  const tiers = {};
  let current = null;
  for (const line of String(yamlText).split(/\r?\n/)) {
    const tier = /^  - name:\s*([a-z0-9_-]+)\s*$/.exec(line);
    if (tier) { current = tier[1]; tiers[current] = []; continue; }
    const preset = /^\s+-\s*\{\s*name:\s*([a-z0-9-]+)\s*,/.exec(line);
    if (preset && current) tiers[current].push(preset[1]);
  }
  for (const name of TIER_NAMES) if (!Array.isArray(tiers[name])) throw Error(`The tier "${name}" was not found in NemoClaw's tiers.yaml.`);
  for (const name of TIER_NAMES) for (const p of tiers[name]) if (!PRESET.test(p)) throw Error('A preset name in tiers.yaml is not valid.');
  return Object.fromEntries(TIER_NAMES.map(name => [name, tiers[name]]));
}

// `nemoclaw <sandbox> policy list`: "● name [origin] — text" for an applied preset, "○ name — text" for one that is not.
export function parsePresetList(text) {
  const applied = new Set(), known = new Set();
  for (const raw of String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const m = /^\s*([●○])\s+([a-z0-9-]+)/.exec(raw);
    if (!m) continue;
    known.add(m[2]);
    if (m[1] === '●') applied.add(m[2]);
  }
  if (!known.size) throw Error('The preset list of the sandbox could not be read.');
  return { applied, known };
}

const managedPresets = tiers => new Set(TIER_NAMES.flatMap(t => tiers[t]));

// The tier whose presets are exactly the applied tier presets, or null when the sandbox has been changed by hand.
export function currentTier(tiers, applied) {
  const managed = managedPresets(tiers);
  const have = [...applied].filter(p => managed.has(p)).sort().join(',');
  return TIER_NAMES.find(t => [...tiers[t]].sort().join(',') === have) ?? null;
}

export function planSwitch(tiers, { applied, known }, target) {
  if (!TIER_NAMES.includes(target)) throw Error('The tier must be restricted, balanced or open.');
  const wanted = new Set(tiers[target]);
  const managed = managedPresets(tiers);
  for (const p of wanted) if (!known.has(p)) throw Error(`NemoClaw does not list the preset "${p}" of this tier for the sandbox.`);
  return {
    from: currentTier(tiers, applied),
    to: target,
    add: [...wanted].filter(p => !applied.has(p)),
    remove: [...applied].filter(p => managed.has(p) && !wanted.has(p)),
  };
}

// Why a sandbox cannot be edited, or null. A sandbox made by Generate Dataset belongs to one execution whose policy must stay unchanged.
export function editBlock(conversation) {
  if (conversation?.execution) return 'This sandbox belongs to a dataset collection execution; its policy must stay unchanged.';
  return null;
}
