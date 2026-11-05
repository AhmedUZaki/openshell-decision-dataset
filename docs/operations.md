# Operations, files and troubleshooting

Daily use, where the files live and how to back them up, and what to do when something fails.

## Daily operation

| Do this | With |
| --- | --- |
| Start everything (Docker Desktop, Ollama, the managed gateway, the OpenClaw sandbox, the OpenShell panel) and open the dashboard at `http://127.0.0.1:18789/` | `Start OpenClaw.cmd` |
| Check the installation (versions against `setup/pins.env`, file checksums, Ollama, the model, the sandbox) | `Verify Installation.cmd` |
| Check the launcher without opening a browser | `powershell -File tools\launchers\Start-OpenClaw.ps1 -CheckOnly` |
| Try one task by hand | the **Conversation** tab of the OpenShell panel ([panel](panel.md)) |
| Collect data in bulk | `Generate Dataset.cmd` ([collecting the dataset](dataset/collecting-data.md)) |

Private data (bundles, evidence, runs, the dataset) is under `.local/` and is ignored by Git.

## Files and backups

The setup spans Ubuntu and Docker storage. It is not stored in one ordinary Windows project folder. Replace `<linux-user>` with your Ubuntu username.

| Content | Ubuntu location |
| --- | --- |
| NemoClaw source | `/home/<linux-user>/.nemoclaw/source` |
| NemoClaw settings and state | `/home/<linux-user>/.nemoclaw` |
| Managed gateway state | `/home/<linux-user>/.local/state/nemoclaw` |
| OpenShell configuration | `/home/<linux-user>/.config/openshell` |
| OpenShell runtime state | `/home/<linux-user>/.local/state/openshell` |
| User-local CLIs | `/home/<linux-user>/.local/bin` |
| Node.js managed by NVM | `/home/<linux-user>/.nvm` |
| System Ollama model store in this setup | `/usr/share/ollama/.ollama/models` |
| OpenClaw state inside the sandbox | `/sandbox/.openclaw` |

### Browse from Windows

Paste in File Explorer:

```text
\\wsl.localhost\Ubuntu-24.04\home\<linux-user>
```

For models:

```text
\\wsl.localhost\Ubuntu-24.04\usr\share\ollama\.ollama\models
```

Linux permissions apply. Avoid directly editing live databases or Docker-managed storage.

### Docker volume

The validated installation uses this named volume for OpenClaw state:

```text
nemoclaw-openclaw-state-v1-my-assistant
```

Find it under Docker Desktop > Volumes. Confirm actual container mounts before backing up; names and layout may change with versions. Volume contents can include credentials, conversations, and personal files. Keep them out of GitHub.

### Backup planning

- Follow current NemoClaw persistence guidance for agent state.
- Preserve model manifests and every referenced blob together.
- Verify the configured model with `ollama list` and `ollama show qwen2.5:1.5b`.
- Restore correct service ownership and permissions.
- Back up Docker Desktop volumes separately from the Ubuntu filesystem.

For a full Ubuntu export, stop active work and run in PowerShell:

```powershell
wsl --terminate Ubuntu-24.04
wsl --export Ubuntu-24.04 C:\Backups\ubuntu-24.04-backup.tar
```

Create the destination directory first and ensure enough free space. Treat the export as private because it can include secrets. A WSL export does not include Docker Desktop named volumes stored outside that distribution.

`wsl --unregister <distribution>` permanently deletes the distribution filesystem. It is not a restart command. Restore and verify required data elsewhere before using it.

## Troubleshooting

### `Start OpenClaw.cmd` stops with "Startup failed"

The launcher prints the failing step and keeps the window open. It deletes nothing and installs nothing.

| Message | What it means and what to do |
| --- | --- |
| `Docker Desktop is not installed at the expected location.` | The launcher looks for Docker Desktop in its default install folder. Install it there, or start it yourself and run the launcher again. |
| `Docker Desktop did not become ready within five minutes.` | Start Docker Desktop manually, wait until its engine says it is running, and run the launcher again. |
| `Could not determine the default Ubuntu username.` | Run `wsl -l -v`: `Ubuntu-24.04` must exist (version 2) and be able to start. |
| `Ollama did not become ready.` | In Ubuntu run `curl http://127.0.0.1:11434/api/version`. If it fails, check `systemctl status ollama` and `journalctl -u ollama`. |
| `The OpenClaw sandbox did not become ready.` | The launcher already retried for several minutes. Run it once more; if it still fails, check Docker Desktop for the `openshell-default--my-assistant-…` container and its logs. |
| `Could not obtain the dashboard URL.` / `The local dashboard is not responding.` | The sandbox is up but the dashboard on port 18789 is not. Run the launcher again; if it persists, restart Docker Desktop. |
| `The dashboard is not serving the current Conversation interface.` | The panel injection was lost (a recreated container does that). The launcher reapplies it; refresh the browser tab afterwards. To do it by hand: `powershell -File tools\events-panel\Enable-Panel.ps1`. |
| `A required update file is missing: tools\events-panel\…` | A file listed in `tools/events-panel/service-files.txt` is missing. Restore it; the list is the only place that names the panel's required files. |

### `Verify Installation.cmd` reports `[FAIL]`

Each check is independent; the message after `[FAIL]` names the cause.

- **`Required WSL 2 distribution was not found.`** `wsl -l -v` must show `Ubuntu-24.04` on version 2.
- **`MISSING`, `MODIFIED` or `UNREGISTERED <file>`.** A protected project file differs from `setup/checksums.json`. If you changed it on purpose, run `npm run checksums:write`; if not, restore the file.
- **Docker or Ollama unreachable.** Start Docker Desktop (with WSL integration for Ubuntu-24.04) and the Ollama service, then run the check again.
- **`Configured model is missing.`** The model named in `setup/pins.env` is not in `ollama list`. Install it again with the installer or `ollama pull <model>` inside Ubuntu.
- **`Expected <version>, got: …`.** An installed component differs from the version pinned in `setup/pins.env`. Reinstall it, or change the pin deliberately and record why.
- **`Preset <name> is not applied.`** Apply it with NemoClaw's own command, for example `nemoclaw my-assistant policy add brave --yes`.

### The panel says "Offline" or answers 401

The panel talks to a local service on `127.0.0.1:18891`. `Offline — run Start OpenClaw.cmd to reconnect` means that service is not running (or was stopped): run `Start OpenClaw.cmd`. When the files in `tools/events-panel/` change, the launcher notices ("Panel service code changed. Restarting it...") and restarts the service itself. A `401` means the page carries an old capability token: refresh the browser tab after the launcher has finished. `Generate Dataset.cmd` also refuses to start while the running service is not the code in this folder.

### A conversation stays "creating", fails, or says "interrupted"

Creating a conversation builds a dedicated sandbox and can take several minutes. A conversation that was creating when the service stopped is marked `interrupted`: its sandbox may exist and holds whatever it did. Open the conversation's card in the Conversation tab and either save what it has or delete it (delete asks for confirmation and keeps saved task bundles unless you tick the box). `Four conversation sandboxes already exist` means the limit of four live sandboxes is reached: delete finished ones first. A sandbox container that the panel does not list is reported by `Generate Dataset.cmd` as `not in the panel list`; look at it with Docker Desktop and remove it before collecting.

### `Generate Dataset.cmd` cannot start or stops

- **A BLOCKED line in the preview** names the failed preflight check; nothing has been created. Fix it and choose the option again.
- **`Another collection is active`** means a run holds `.local/runs/active-run.json`. If the process that wrote it is gone the lock is stale and is cleared automatically; otherwise let the run finish, or stop it with Ctrl+C (it finishes the execution in progress first).
- **A failed execution** keeps its sandbox and its partial evidence and stops the run. Read the message, fix the cause, then open `Generate Dataset.cmd` > 1 > **2) Resume a previous collection**. Resume skips every execution whose bundle and evidence verify. An execution that saved its Bundle and then stopped on a stop condition is not run again: it is finalized (its Sandbox is closed, its Bundle keeps its excluded routing) and the collection continues. If the sandbox of the failed execution is still listed, delete it from the panel when you no longer need it.
- **`The task changed since the collection started`** means a task file was edited during or after the run began. Resume refuses, because a sample must be attributed to the exact task text it was collected with. Start a new collection.
- **Executions with no samples** are normal: the 1.5B model often answers without calling a tool. They are saved and count as completed.
- **`the new Dataset does not validate`, `Independent verification failed` or `not deterministic`** from `npm run create:dataset` means the Bundles or the source changed in a way the builder and the independent verifier disagree about; nothing was saved. `npm run verify:safety-router` re-checks the newest Dataset (a failure there means a Bundle or the source changed since it was created: create a new Dataset).
- **Task catalog errors** (`Generate Dataset.cmd` > 1 > 3, or `node safety-router-dataset/collect-data/validate-task-catalog.mjs`) are listed with the file and the rule. A changed task needs a higher `version`, then `--update-registry` ([task catalog](../safety-router-dataset/task-catalog/README.md)).

### A transport rejection while checking readiness

Prefer a maintained release containing the fix. The compatibility backport was a version-specific source backport, not a universal installation step (see [setup](setup.md)). Never skip the check or broadly accept all network errors. A transport rejection proves direct-path unavailability; it does not necessarily prove an HTTP policy rejection.

### Chat fails during transcript compaction

An observed failure reported `Pending input is no longer active in its admitted transcript` after an authorized model request returned HTTP 200. The initial OpenClaw context was 16384 tokens, while the active Ollama runner used only 4096. Context pressure repeatedly invoked compaction.

The local repair aligned the Ollama service context and the OpenClaw model context to 32768, reduced the configured maximum output to 2048, and selected OpenClaw's supported `default` compaction mode. The existing conversation history was preserved. The Ollama setting is stored in `/etc/systemd/system/ollama.service.d/context-window.conf`; the agent settings are in its private OpenClaw configuration.

The runner was verified at a 32768-token context on GPU. An actual arithmetic request returned `12`, and a subsequent conversational request returned a normal readiness greeting. The latter took several minutes in the existing session. Larger contexts require more memory; this configuration is specific to the tested machine. For fresh recreation, set the corresponding NemoClaw build-time context/output limits before onboarding, because recreating a sandbox can replace native runtime overrides.

### Opening a conversation takes about 40 seconds

By default Ollama unloads a model after 5 idle minutes. The next request, including the readiness check behind **Open isolated chat**, then waits for a cold load: about 41 s measured on this machine (RTX 3080, 10 GB, 32768-token context) against 0.3 s with the model loaded. A second large model resident in the same GPU memory makes it slower.

The service sets `OLLAMA_KEEP_ALIVE=1h` in `/etc/systemd/system/ollama.service.d/keep-alive.conf` (also written by `install-stack.sh`). With the model loaded, opening a conversation took 3.5 s. The first request after Ollama or the WSL distro restarts still pays one cold load, and the model holds about 2 GB of GPU memory for the hour. To change it, edit that file, then run `sudo systemctl daemon-reload && sudo systemctl restart ollama`.

### Inspect model memory

```bash
ollama ps
```

shows the loaded model, its size and whether it runs on the GPU.
