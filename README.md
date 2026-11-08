# NemoClaw + OpenClaw on Windows with Local Ollama

An independent, reproducible setup for running OpenClaw in a NemoClaw-managed OpenShell sandbox on Windows (Ubuntu 24.04 on WSL 2, Docker Desktop, local Ollama), and for building a **Safety Router dataset**: real examples of what OpenShell decides. The one active experiment is the **Single-Action Policy Test**: the Agent is asked for exactly one tool action, once, against one destination, inside its own isolated Sandbox under one unchanged policy. The project stores the complete Agent timeline, the complete OpenShell timeline, the applied policy and the policy result taken only from OpenShell's own explicit `ALLOW`/`DENY` events.

```text
Single-Action Policy Test -> one Agent tool call -> one destination -> one unchanged policy
  -> one isolated Sandbox -> complete Agent timeline -> complete OpenShell timeline -> one Safety Router record
```

It contains scripts, manifests, documentation and tooling only: no credentials, model weights or NVIDIA source code. It is not an official NVIDIA project.

## Four steps

| Step | Do this | Details |
| --- | --- | --- |
| 1. Install | Double-click `Install Everything.cmd` (it installs Ubuntu on WSL 2, Docker Desktop and Node.js with winget when missing, then the pinned stack), then `Verify Installation.cmd` | [Portable rebuild](docs/setup.md#portable-rebuild-and-private-backup) (automatic), [Installation](docs/setup.md#installation) (manual equivalent) |
| 2. Try the Agent by hand | Double-click `Start OpenClaw Workspace.cmd` and chat in the dashboard. The **OpenShell** panel on the right shows each message, every tool call with its arguments and result, and the ALLOWED/DENIED decision OpenShell logged for it | [docs/panel.md](docs/panel.md#openshell-panel-in-the-dashboard) |
| 3. Collect data | Double-click `Generate Dataset.cmd`, press 1 (Collect new data), then 1 in the collector menu: choose policies, tests and the number of independent executions, review the calculation, type `RUN`. It ends with export, validation and verification of the Safety Router Dataset | [docs/dataset/collecting-data.md](docs/dataset/collecting-data.md), [tasks](safety-router-dataset/task-catalog/README.md) |
| 4. Create the Dataset | `Generate Dataset.cmd` option 2, Create Dataset (or `npm run create:dataset`): builds, validates, verifies independently and saves a NEW folder named with its UTC creation time under `.local/safety-router/datasets/` | [docs/dataset/safety-router-dataset.md](docs/dataset/safety-router-dataset.md) |

> **License: MIT** (code and documentation). See [LICENSE](LICENSE). A released dataset needs its own terms.

## Layout

```text
Install Everything.cmd   Start OpenClaw Workspace.cmd   Verify Installation.cmd   Generate Dataset.cmd
package.json             validation and dataset scripts
setup/     the environment: pins.env (every version in one file), installer, verifier, checksums.json, Generate-Dataset.ps1
tools/     launchers/ (starts everything), events-panel/ (the OpenShell panel in the dashboard and its local service: conversation manager and evidence) and integrity-check/ (source checksums)
safety-router-dataset/   source code and schemas only: task-catalog/ (the 12 Single-Action Policy Tests), collect-data/ (Generate Dataset.cmd), create-dataset/ (build, validate, verify, schemas), release-checks/ (secret and path scans)
released-dataset/   the published snapshot: 51 accepted records, its manifest and a README (a reviewed export, never read by the tools)
docs/      documentation; docs/dataset/ is the methodology
.local/    private runtime data (never committed): Captures, evidence, Runs and the Safety Router Dataset
```

## Architecture: where the dataset lives

Several folders hold dataset-related files. **They are layers of one pipeline, not duplicate datasets.** Every Dataset is created in its own timestamped folder (`.local/safety-router/datasets/safety-router-dataset-<UTC timestamp>/`); its `accepted-execution-records.jsonl` is the authoritative accepted Dataset. It is the complete record of every accepted execution; it is not a model-specific fine-tuning format, and any trainer-specific conversion must be derived from it.

| Folder | What it holds | In Git? |
| --- | --- | --- |
| `safety-router-dataset/` | Source code, schemas and the human-editable task catalog. No data. | Yes |
| `.local/task-captures/` | One Bundle (Capture) per execution | No |
| `.local/evidence/raw/` | Immutable original OpenShell evidence (never publish) | No |
| `.local/evidence/sanitized/` | Derived, redacted evidence | No |
| `.local/runs/` | Collection state, reports and per-execution log boundaries | No |
| `.local/safety-router/datasets/` | One folder per created Dataset, named with its UTC creation time: `accepted-execution-records.jsonl`, `needs-review-records.jsonl`, `excluded-execution-index.jsonl`, `manifest.json` | No |
| `docs/dataset/` | Methodology | Yes |
| `released-dataset/` | A reviewed, public export of one Dataset (accepted records and manifest only). Not generated by the tools | Yes |

Git holds the code, schemas, catalog, documentation and the reviewed export in `released-dataset/`; the repository is public at https://github.com/AhmedUZaki/openshell-decision-dataset. Evidence, Bundles and the generated Datasets stay local. More: [docs/development.md](docs/development.md) (tracked versus local, new computer, tests, checksums).

## Test and check

```text
npm run validate:catalog      the active task catalog (12 Single-Action Policy Tests)
npm run create:dataset  build, verify and save a new timestamped Dataset from the saved Bundles
npm run validate:safety-router    validate it
npm run verify:safety-router      independently verify it against the Bundles
npm run verify:safety-router:determinism   two builds must be identical
npm run checksums:check       protected source files against setup/checksums.json
npm run scan:source           secrets and user-specific paths in every file Git would include
```
## Policy

Sandboxes use NemoClaw's own default policy tiers with no hand-written rules: **Balanced (default)** (the NemoClaw baseline plus `npm`, `pypi`, `huggingface`, `brew-balanced` and `brave`), and `restricted`/`open`, which you choose per collection. Details: [docs/policies.md](docs/policies.md), [collecting the dataset](docs/dataset/collecting-data.md).

## Reproducibility

- `setup/pins.env` is the single source for the model, Ollama, NemoClaw (with the exact commit and backport), OpenClaw and OpenShell versions, the sandbox name, port, context window and policy tier. The installer reads it and the verifier checks the installed versions against it.
- Every saved bundle contains `environment.json`: the pins, the versions reported at save time, the Ollama model ID and the policy hash. A bundle can be traced to the environment that produced it.
- `setup/checksums.json` registers every protected source file (setup, launchers, panel, collector, builder, schemas, task catalog, test launcher); `Verify Installation.cmd` reports modified, missing and unregistered ones.
- Newly saved bundles record the project source identity (Git commit and dirty flag when Git is available, otherwise `null`, plus a hash of the protected source files).
- Tasks are JSON files in `safety-router-dataset/task-catalog/` that you can read and edit; a new valid file appears in the collector and the panel without changing any code (then run `--update-registry` and `npm run checksums:write`, see [task catalog](safety-router-dataset/task-catalog/README.md)). A task is natural-language input for the Agent, never a command and never an expected verdict, and it declares exactly one tool, one URL and one call. Collection is **autonomous**: every execution is one test under one policy in a new Conversation and Sandbox, so re-running a test reproduces the protocol, not the Agent's exact tool calls. The Dataset is rebuilt deterministically from the saved Bundles (`npm run verify:safety-router:determinism`). Association of events with the one action is by the isolated Sandbox plus saved log boundaries, not by a per-call id; `qwen2.5:1.5b` is unreliable at tool use, so many executions are excluded from training with their reasons. [Details](docs/dataset/collecting-data.md), [evidence layers](docs/dataset/evidence-layers.md).

## Documentation

1. [Installation](docs/setup.md#installation)
2. [Daily operation](docs/operations.md#daily-operation)
3. [Troubleshooting](docs/operations.md#troubleshooting)
4. [Files and backups](docs/operations.md#files-and-backups)
5. [Security and GitHub publishing](docs/security-and-publishing.md) · [Project structure, tests and portability](docs/development.md) · [License](LICENSE)
6. [OpenShell panel](docs/panel.md#openshell-panel-in-the-dashboard) · [launcher](docs/setup.md#launcher) · [policies](docs/policies.md) · [compatibility backport](docs/setup.md#compatibility-backport)
7. Dataset: [workflow](safety-router-dataset/README.md) · [collecting it (Generate Dataset.cmd)](docs/dataset/collecting-data.md) · [tasks](safety-router-dataset/task-catalog/README.md) · [evidence layers](docs/dataset/evidence-layers.md) · [the Safety Router dataset](docs/dataset/safety-router-dataset.md) · [record format](docs/dataset/safety-router-dataset.md#one-record)

## Validated configuration

| Component | Configuration |
| --- | --- |
| Host | Windows 11, x86-64 |
| Linux | Ubuntu 24.04 LTS on WSL 2 |
| Containers | Docker Desktop with WSL integration |
| Inference | Ollama inside Ubuntu |
| Model | `qwen2.5:1.5b` (primary) |
| Agent | OpenClaw |
| Sandbox | `my-assistant` |
| Policy | Balanced tier (`npm`, `pypi`, `huggingface`, `brew-balanced`, `brave`) on the NemoClaw baseline |
| Hardware | RTX 3080 10 GB; 64 GB RAM; about 32 GB available to WSL |
| Optional integrations | Web search and messaging disabled |

This is a tested example, not a minimum specification. Model context and other applications affect GPU memory requirements. Ollama uses the host GPU; direct GPU access inside the agent sandbox was disabled.

Verified with OpenClaw 2026.9.2, OpenShell 0.0.116, NemoClaw 0.0.140 and Ollama 0.40.13 (see `setup/pins.env`). A local backport of an upstream NVIDIA fix was needed for the installed NemoClaw release ([compatibility backport](docs/setup.md#compatibility-backport)); after it, onboarding completed and an agent test returned `READY`. See [Troubleshooting](docs/operations.md#troubleshooting).

## Official references

- [Quickstart](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/get-started/quickstart)
- [Windows preparation](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/additional-setup/windows-preparation)
- [Prerequisites](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/prerequisites)
- [Ollama setup](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/inference/local-inference/set-up-ollama)
- [NVIDIA NemoClaw source](https://github.com/NVIDIA/NemoClaw)

Reviewed November 2, 2026. Check the maintained documentation before installing: supported platforms and commands can change.
