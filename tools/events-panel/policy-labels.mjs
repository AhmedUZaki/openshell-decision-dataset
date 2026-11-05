// NemoClaw's tier names as shown to people. Balanced is the tier NemoClaw selects when none is chosen.
export const POLICY_LABELS = { restricted: 'Restricted', balanced: 'Balanced (default)', open: 'Open', personal: 'Personal' };
export const policyLabel = tier => POLICY_LABELS[String(tier || '').toLowerCase()] ?? null;
