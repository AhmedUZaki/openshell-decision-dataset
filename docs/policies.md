# OpenShell Policies

## Policy used in this project

Every sandbox in this project runs one of NemoClaw's own default network policy tiers, without custom rules: **Balanced (default)** unless the collection or the manual conversation asks for `restricted` or `open` ([collecting the dataset](dataset/collecting-data.md)). Balanced is the NemoClaw baseline (`nemoclaw-blueprint/policies/openclaw-sandbox.yaml`, deny by default) plus NemoClaw's Balanced presets `npm`, `pypi`, `huggingface`, `brew-balanced` and `brave`; `tavily` is not added because NemoClaw applies it only when it is the selected search provider. The only other rules are ones NemoClaw and OpenClaw add themselves (the local-inference rule and `openclaw-pricing`). Because non-interactive onboarding leaves `brave` out, the project applies it with NemoClaw's own `policy add brave`. No rule was written by hand, so a model trained on this dataset learns NemoClaw's own defaults, and the setup is reproducible from the pinned NemoClaw commit with `NEMOCLAW_POLICY_TIER=balanced` (see `setup/pins.env`).

The installed policy templates are in Ubuntu:

```text
~/.nemoclaw/source/nemoclaw-blueprint/policies/openclaw-sandbox.yaml
~/.nemoclaw/source/nemoclaw-blueprint/policies/presets/
~/.nemoclaw/source/nemoclaw-blueprint/policies/tiers.yaml
```

The project uses one policy for every sandbox: the NemoClaw baseline plus the **Balanced** tier (`npm`, `pypi`, `huggingface`, `brew-balanced`, `brave`; `tavily` only when it is the selected search provider). Non-interactive onboarding omits `brave`, so `setup/pins.env` lists it under `POLICY_EXTRA_PRESETS` and the installer and the conversation manager apply it with `nemoclaw <sandbox> policy add brave --yes`. `Verify Installation.cmd` checks that it is applied. OpenClaw adds `openclaw-pricing` itself, and NemoClaw adds the local-inference rule.

Every conversation starts with this one policy, named **Balanced (default)** in the bundle (`environment.json`, `policy.label`) and in the training files (`policy_profile`). OpenShell keeps a numbered revision history per sandbox (setup produces a few revisions before the first message); a bundle stores only the revision the task ran under, and the number appears in metadata only, not in the text the model is trained on.

These are templates. The authoritative effective policy is attached to the running sandbox and may include provider-composed rules and applied presets.

Inspect it inside Ubuntu:

```bash
~/.local/bin/openshell policy get my-assistant --full
```

Export structured data:

```bash
~/.local/bin/openshell policy get my-assistant --full --output json
```

The current sandbox uses Balanced plus presets, not an untouched default policy. Real policy snapshots may include machine-specific or private endpoints, so they stay under the ignored `.local/` folder.
