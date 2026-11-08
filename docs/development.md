# Project structure, checks and portability

## What lives where

Several folders hold dataset-related files. **They are not duplicate datasets:** each holds a different layer of one pipeline, and `accepted-execution-records.jsonl` is the authoritative accepted Dataset.

| Folder | Holds | In Git? |
| --- | --- | --- |
| `safety-router-dataset/` | Source code, schemas and the human-editable task catalog (`safety-router-dataset/task-catalog/`). It contains no data. | Yes |
| `.local/safety-router/datasets/` | **Generated** Safety Router Datasets, one timestamped folder each: `accepted-execution-records.jsonl`, `needs-review-records.jsonl`, `excluded-execution-index.jsonl`, `manifest.json`. | No |
| `.local/task-captures/` | One Bundle (Capture) per execution | No |
| `.local/evidence/raw/` | Immutable original evidence | No, never publish |
| `.local/evidence/sanitized/` | Derived, redacted evidence | No |
| `.local/runs/` | Collection state, reports and per-execution log boundaries (`boundaries/`) | No |
| `docs/dataset/` | Methodology documentation | Yes |

## Tracked, local, recreatable, backed up

| Kind | Examples | How to get it back |
| --- | --- | --- |
| **Tracked in Git** | installer and launchers, the panel and collector code, schemas, the task catalog, documentation, `setup/checksums.json` | clone the repository |
| **Local only** | `.local/` (Bundles, evidence, runs, the Dataset), the panel's state and capability token, models, volumes | not in Git |
| **Recreated from source** | the Ubuntu, Docker, Ollama, NemoClaw, OpenClaw and OpenShell installation (pinned in `setup/pins.env`); the Safety Router Dataset from saved evidence | `Install Everything.cmd`; `npm run create:dataset` |
| **Needs a separate backup** | the evidence and Bundles themselves | a private backup of `.local/` |

The Agent's exact behavior is **not reproducible**: it chooses its own tools and wording, so a new run produces different tool calls. What is reproducible is the derivation. The same saved Bundles deterministically produce the same Safety Router Dataset, and `npm run verify:safety-router:determinism` proves it by building twice and comparing with the files on disk; `npm run verify:safety-router` independently re-derives every record from its Bundle.
## Install on another computer

1. Clone the repository (or copy the folder) to any location; no step depends on a particular path.
2. Install Node.js 20 or newer on Windows (only the standard library is used; there is nothing to `npm install`).
3. Double-click `Install Everything.cmd`, then `Verify Installation.cmd` (see [setup.md](setup.md)).
4. Copy your private `.local/` backup only if you need earlier evidence; the Dataset is rebuilt from it with `npm run create:dataset`.

## Run the checks

The automated tests of this project are kept only on the maintainer's computer and are not published. The checks below are all in the repository.

| What | Command | Notes |
| --- | --- | --- |
| Validate the active task catalog | `npm run validate:catalog` | the 12 Single-Action Policy Tests |
| Create the Safety Router Dataset | `npm run create:dataset` | reads active Bundles, builds, validates and verifies, then saves a new timestamped folder |
| Validate it | `npm run validate:safety-router` | schema and rules for the accepted, needs-review and excluded-index files |
| Verify it independently | `npm run verify:safety-router` | re-derives every field from its Bundle |
| Determinism | `npm run verify:safety-router:determinism` | two builds identical and equal to the files on disk |
| Protected-source checksums | `npm run checksums:check` | the same comparison `Verify Installation.cmd` performs |
| Scan for secrets and user paths | `npm run scan:source` | every file Git would include |

## Protected source files and `setup/checksums.json`

Every file that defines the dataset or runs the setup is registered with a SHA-256 in `setup/checksums.json`: the setup scripts and `pins.env`, the root `.cmd` launchers and `package.json`, everything under `tools/`, `safety-router-dataset/` (collector, builder, schemas, the scans, the task catalog and every task file). Generated data (`.local/`), secrets, evidence, Runs and Captures are never registered.

`Verify Installation.cmd` and `npm run checksums:check` report three different problems:

| Report | Meaning |
| --- | --- |
| `MISSING` | a registered file is not on disk |
| `MODIFIED` | a registered file's SHA-256 changed |
| `UNREGISTERED` | a protected source file exists that the manifest does not list |

After a deliberate change to a protected file or after adding one, regenerate the manifest and review the diff:

```powershell
npm run checksums:write
npm run checksums:check
```

Generation is deterministic (sorted forward-slash paths, SHA-256 of the exact bytes, no timestamps). The check detects accidental drift and incomplete edits; it is not protection against someone who can also rewrite the manifest.

## Changing the exporter or the validators

The Safety Router records carry no exporter hash: the independent verifier re-derives every field from the Bundle with its own code, and the determinism check compares two builds with the files on disk. After a change to the builder, exporter, validator, verifier or schema, run `npm run create:dataset`, then `npm run checksums:write` and `npm run checksums:check`. The exporter reads only Bundles whose saved `task.json` declares `task_type` `single_action_policy_test`; anything else is outside the protocol.
