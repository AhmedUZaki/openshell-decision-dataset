# OpenShell Policies

## Policies used in this project

Every sandbox in this project runs one of NemoClaw's own default network policy tiers, without custom rules. `Generate Dataset.cmd` lets you choose **Restricted**, **Balanced (NemoClaw default)**, **Open** or all three for each collection ([collecting the dataset](dataset/collecting-data.md)). The tier of an execution stays unchanged for that execution and is stored in its record as `policy_profile` (`restricted`, `balanced` or `open`).

- **Balanced** is the NemoClaw baseline (`nemoclaw-blueprint/policies/openclaw-sandbox.yaml`, deny by default) plus NemoClaw's Balanced presets `npm`, `pypi`, `huggingface`, `brew-balanced` and `brave`. `tavily` is not added because NemoClaw applies it only when it is the selected search provider. Because non-interactive onboarding leaves `brave` out, the project applies it with NemoClaw's own `policy add brave` (`POLICY_EXTRA_PRESETS` in `setup/pins.env`).
- **Restricted** and **Open** are NemoClaw's own tiers, each a list of presets in NemoClaw's `tiers.yaml` (switching Restricted to Open adds eleven presets).
- Other rules are added by NemoClaw and OpenClaw themselves (the local-inference rule and `openclaw-pricing`). No rule was written by hand, so a model trained on this dataset learns NemoClaw's own defaults.
- The tier NemoClaw gives a new sandbox stays `POLICY_TIER=balanced` in `setup/pins.env`. The shared `my-assistant` sandbox can be switched between tiers by hand from the panel ([panel](panel.md#switching-the-policy-tier)); that is for trying the Agent, not for collecting data.

The installed policy templates are in Ubuntu:

```text
~/.nemoclaw/source/nemoclaw-blueprint/policies/openclaw-sandbox.yaml
~/.nemoclaw/source/nemoclaw-blueprint/policies/presets/
~/.nemoclaw/source/nemoclaw-blueprint/policies/tiers.yaml
```

OpenShell keeps a numbered revision history per sandbox (setup produces a few revisions before the first message); a Bundle stores only the revision the task ran under, and the number appears in metadata only, not in the text a model would be trained on.

These are templates. The authoritative effective policy is attached to the running sandbox and may include provider-composed rules and applied presets. Each record keeps that complete effective policy in `applied_policy.policy_snapshot`.

Inspect it inside Ubuntu:

```bash
~/.local/bin/openshell policy get my-assistant --full
```

Export structured data:

```bash
~/.local/bin/openshell policy get my-assistant --full --output json
```

A sandbox uses a tier plus presets, not an untouched default policy. Real policy snapshots may include machine-specific or private endpoints, so they stay under the ignored `.local/` folder, except in the reviewed export in `released-dataset/`.
