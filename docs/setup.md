# Setup, rebuild and launcher

How the environment is installed and rebuilt, how `Start OpenClaw.cmd` starts it, and the compatibility backport.

## Installation

**Recommended:** double-click `Install Everything.cmd` (see [Portable rebuild](#portable-rebuild-and-private-backup)). The steps below are the manual equivalent for reference; they install the latest Ollama and NemoClaw, not the versions pinned in `setup/pins.env` or the compatibility backport, so `Verify Installation.cmd` may report version mismatches after a manual install.

### 1. Check prerequisites

Needed on the Windows host: Windows 11 (x86-64, the only tested version), hardware virtualization enabled in the BIOS/UEFI, `winget` (Microsoft App Installer; the installer uses it for Docker Desktop and Node.js), an internet connection (the installer downloads Ubuntu, Docker images and the `qwen2.5:1.5b` model), and Administrator approval. Node.js 20 or newer on Windows runs the panel, the collector and the tests; `Install Everything.cmd` installs it with winget when missing (manually: `winget install OpenJS.NodeJS.LTS`, then open a new terminal and check `node --version`).

In Windows PowerShell:

```powershell
wsl --status
wsl --list --verbose
nvidia-smi
```

NVIDIA lists a base minimum of 4 vCPUs, 8 GB RAM, and 20 GB free disk, with 16 GB RAM and 40 GB disk recommended. Local model requirements are additional. Leave space for downloads, extracted container images, models, and backups.

### 2. Install Ubuntu 24.04

In PowerShell, approving administrator access when requested:

```powershell
wsl --install -d Ubuntu-24.04
```

Complete the Ubuntu username and password prompts locally. Restart Windows if prompted. Then verify WSL 2 and select the distribution:

```powershell
wsl --list --verbose
wsl --set-default Ubuntu-24.04
wsl -d Ubuntu-24.04
```

Use the documented Ubuntu 24.04 path rather than assuming a newer release is qualified. Preserve required data before removing any older distribution.

### 3. Install Docker Desktop

In PowerShell:

```powershell
winget install --id Docker.DockerDesktop --exact
```

Open Docker Desktop and finish its first-run screens. Enable the WSL 2 backend and integration for **Ubuntu-24.04**. Depending on the version, this is under Settings > Resources > WSL Integration or Settings > WSL integration. Apply changes and wait for the engine to run.

Inside Ubuntu:

```bash
docker info
docker context show
```

The server should identify Docker Desktop. Avoid a competing Docker Engine inside the same WSL distribution. Review Docker Desktop licensing for your intended use.

### 4. Install or reuse Ollama

Inside Ubuntu, inspect existing installations first:

```bash
ollama --version
curl -fsS http://127.0.0.1:11434/api/version
ollama list
```

For a fresh installation, download and review the official installer:

```bash
sudo apt-get update
sudo apt-get install -y zstd binutils
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
less /tmp/ollama-install.sh
sh /tmp/ollama-install.sh
```

The installer can require sudo. Enter passwords only in the local prompt.

Pull the example model only if it is missing:

```bash
ollama pull qwen2.5:1.5b
ollama list
```

The portable setup downloads only `qwen2.5:1.5b`. Runtime GPU memory is separate from file size. Keep one active Ollama server for this setup, bound to loopback. A cloud API key is not required for local Ollama.

### 5. Install NemoClaw

Run as your normal Linux user inside Ubuntu. Download and review the official installer:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh -o /tmp/nemoclaw-install.sh
less /tmp/nemoclaw-install.sh
export NEMOCLAW_DISABLE_TELEMETRY=1
export NEMOCLAW_SANDBOX_GPU=0
bash /tmp/nemoclaw-install.sh
```

The installer follows its maintained release by default and installs dependencies such as Node.js when needed. Read the third-party software notice and accept only if you agree.

For this guide, decline Express if needed to select settings manually:

- Agent: OpenClaw.
- Provider: local Ollama inside WSL.
- Model: `qwen2.5:1.5b`.
- Sandbox: `my-assistant`.
- Web search: disabled initially.
- Messaging: none initially.
- Policy: Balanced.

`NEMOCLAW_SANDBOX_GPU=0` disables direct agent-container GPU access; Ollama still uses the host GPU. For separate onboarding, `nemoclaw onboard --no-sandbox-gpu` provides the equivalent option.

### 6. Verify and connect

```bash
export NEMOCLAW_DISABLE_TELEMETRY=1
nemoclaw my-assistant status
nemoclaw my-assistant dashboard-url --quiet
```

Open the complete URL printed by the last command on the same Windows computer. It may contain a private `#token=` fragment. A bare dashboard URL can load the page while leaving its WebSocket unauthenticated.

Do not publish the authenticated URL. Verify that the agent answers a harmless message before declaring success. If onboarding stops, follow its specific error and the troubleshooting guide.

## Portable rebuild and private backup

This repository has two portability layers.

### Public reproducible setup

The repository records immutable NemoClaw source commits, validated component
versions, the single Ollama model tag, application code, policies, schemas, and
Windows/Ubuntu installation scripts. It is suitable for GitHub after the normal
security review.

On a new x86-64 Windows 11 computer:

1. Copy or clone this repository.
2. Double-click `Install Everything.cmd`. It also installs Node.js LTS with winget if `node` is missing.
3. Approve the Administrator prompt.
4. Complete the Ubuntu Linux username and password setup if it appears.
5. Restart Windows if requested, then run the same file again.
6. Complete Docker Desktop's first-run screen and enable WSL integration for
   `Ubuntu-24.04` if requested.
7. Enter the Ubuntu sudo password if prompted.
8. Wait while the installer downloads `qwen2.5:1.5b`, installs the pinned stack,
   creates `my-assistant`, applies the panel, and verifies isolation.
9. Run `Verify Installation.cmd`, then `Start OpenClaw.cmd`.

The scripts are resumable. They preserve existing sandboxes and do not delete
other Ollama models. Only `qwen2.5:1.5b` is requested by this setup.

### Private data

Saved Bundles, evidence, Runs and Datasets live under `.local/` (private, excluded by
`.gitignore`): `task-captures/`, `evidence/`, `runs/` and `safety-router/`. The installer does
not move them; copy the whole `.local/` folder yourself, using encrypted storage, if you need
the data on another computer.

### Downloaded instead of stored

The repository does not contain Windows installers, Ubuntu virtual disks,
Docker images, Ollama weights, NVIDIA source code, tokens, or credentials.
Those items are large, machine-specific, separately licensed, or secret. The
manifests and scripts download or recreate them from official sources.

Reproducibility depends on the immutable upstream Git commits and official
download endpoints remaining available. The installer stops on a mismatch or
missing prerequisite instead of silently substituting another component.

## Launcher

Double-click "Start OpenClaw.cmd" in the project folder.

The launcher starts Docker Desktop if needed, checks Ubuntu Docker integration,
starts the existing Ollama and managed gateway services, runs NemoClaw recovery
starts the current OpenShell panel service (the collector needs it), adds the
OpenShell panel to the dashboard and opens the authenticated local OpenClaw
dashboard in your browser. Chat there; the panel on the right shows the Agent's
tool calls and OpenShell's decisions.

Collect data with Generate Dataset.cmd. Private captures are stored under
.local/task-captures in the project folder. The launcher does not create, delete
or reset conversations automatically.

The dashboard token is retrieved at runtime and is not saved in these files.
No software is installed, no files are deleted, and no network policy is changed.
Existing services are reused rather than starting duplicate Ollama servers.

Keep the tools and setup folders next to "Start OpenClaw.cmd". The launcher is configured for
Ubuntu-24.04 and sandbox my-assistant. The default Linux username is detected.
Docker startup can take up to five minutes. Additional recovery can take longer.
If Windows requests an application permission or first-run action, handle it
yourself, then rerun the launcher. Errors remain visible for troubleshooting.

The command file uses a process-scoped PowerShell execution-policy override.
It does not change the computer's saved execution policy.

This project contains launchers, scripts and documentation. Installed Linux programs,
Docker volumes, and model weights remain in Ubuntu and Docker-managed storage.

## Compatibility backport

The validated Windows installation uses NemoClaw source commit
`88fe14f3fb9a0bf72997cce19ec88b5b2ee08391` with three files taken from
upstream commit `4ec4ec634e5e9cf5f00c6bb2d2786a5b5b73eef9`.

The backport fixes the dual-stack direct-host isolation probe on Docker Desktop.
The portable Linux installer fetches both immutable commits and checks out only
these files from the backport commit:

- `src/lib/onboard/compatible-endpoint-smoke.ts`
- `src/lib/onboard/compatible-endpoint-smoke.test.ts`
- `src/lib/onboard/__test-helpers__/compatible-endpoint-smoke-helpers.ts`

This records the exact provenance without copying NVIDIA-owned source files into
this independent repository. If an immutable commit is no longer available, the
installer stops instead of silently installing different code.
