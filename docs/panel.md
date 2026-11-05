# OpenShell panel

The side panel added to the OpenClaw dashboard, and the isolated conversations it creates.

## OpenShell Events Side Panel

For conversation-specific evidence and saving tasks, see [Isolated Conversations](#isolated-conversations-and-evidence-bundles). The shared sandbox no longer displays sandbox-wide logs as if they belonged to a particular chat. Create an isolated conversation using the Conversation tab.

This local extension adds a collapsible panel to the existing OpenClaw dashboard at `http://127.0.0.1:18789/`. It has three tabs: **Conversation** (create, open, save, close and delete isolated conversations), **Policies** and **Events**. Bulk dataset collection is not done here: use `Generate Dataset.cmd`.

### Conversation tab: one Single-Action Policy Test by hand

Choose one **Single-Action Policy Test** from `safety-router-dataset/task-catalog/` (there is no category, task-source or custom-task choice), read its full text and details (the text is sent to the Agent exactly as written; to change it, edit its file), choose **Restricted**, **Balanced — NemoClaw default** or **Open**, and press **New conversation**: one isolated Conversation and Sandbox is created. Talk to the Agent, watch the OpenShell events, then **Save task bundle** or **Close conversation**. The task is recorded with its `task_id`, `task_version` and `task_hash`, and its `task_type` and `single_action` declaration; the server reads the text, version and hash from the catalog, and the browser only names the task. The panel has no custom manual task, batch collection, multi-task selection, run counts, estimates, batch progress, Dataset tab or export controls. Every save writes the raw and sanitized OpenShell evidence ([evidence layers](dataset/evidence-layers.md)). Under each saved Bundle, **Show complete Agent and OpenShell timelines** displays the full Agent timeline and the full OpenShell timeline (every event with its origin and decision, as text) and the policy result, completion result and training eligibility; it asks the panel service (`POST /conversations/timeline`, read-only) to build them from the Bundle exactly as the Dataset exporter does.

### Policies tab (read-only)

**OpenShell > Policies** shows the policy the sandbox is running: network policies, filesystem policy, and process and Landlock settings, with the revision number and source. It cannot change anything. The project uses one policy for every conversation, NemoClaw's default **Balanced (default)** ([policies](policies.md)), so editing is deliberately not offered: a changed rule would make the conversations in the dataset run under different policies. To change a policy, use `nemoclaw <sandbox> policy add/remove` or `openshell policy update` yourself, and expect the difference to be recorded in the bundle's policy versions.

### Start

Use the project's `Start OpenClaw.cmd`. It also starts this panel and reapplies the small dashboard injection if a container recreation removed it. Refresh an already open browser tab after enabling.

For manual setup after the sandbox is running:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\events-panel\Enable-Panel.ps1"
```

The default view shows recent activity, including explicit denies. Use **Explicit decisions** or **Denied only** to filter. Close/reopen with the OpenShell events button. Uncheck Live to pause polling.

### Meaning of the results

- `DENIED`: the log explicitly contains DENIED.
- `ALLOWED`: the log explicitly contains ALLOWED.
- `OBSERVED`: a logged operation without an explicit decision; this is not proof of allowance.

Configuration records, SSH relays and dashboard loopback noise are excluded. Not every filesystem operation has an individual OpenShell event. An empty panel is not proof that all actions were allowed. Events are sandbox-wide and are not automatically correlated with individual chat messages or tool calls. These cards are not verified dataset labels.

### Implementation and boundaries

- `panel-service.mjs` runs on Windows Node.js, binds only to `127.0.0.1:18891`, and invokes the fixed `openshell logs my-assistant --source sandbox -n 200` command.
- The API permits the exact dashboard origin and requires a random local capability header. Host checks reject DNS rebinding. Mutations (the Conversation tab) additionally require that exact Origin header, JSON input, and explicit confirmation for close and delete. Commands are fixed argument arrays, without a shell or arbitrary executable selection.
- The injected same-origin script renders log details as text, without interpreting log content as HTML. Common token/password patterns and URL queries/fragments are redacted. This is a conservative display filter, not a complete sensitive-data detector.
- Local runtime state and the generated authenticated script are under `.local/`, ignored by Git. Never upload that folder or raw private logs.
- Up to 80 normalized events from the current 200-line log window are retained in memory. Polling stops for hidden tabs, the Policies tab, or a closed/paused panel. Logs are not exported to a third party or saved by the bridge.
- The original application bundle is unchanged; one separate script tag is added to its HTML. A container rebuild or app update can remove that injection. The launcher can reapply it while this installed UI layout remains compatible.
- The built-in gateway content-security policy is retained. The panel relies on its existing localhost connection allowance.

### Remove

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\events-panel\Enable-Panel.ps1" -Remove
```

This removes the script tag and stops the matching bridge process. To keep it disabled, also remove or rename `Enable-Panel.ps1` so the launcher does not enable it again. Refresh the browser. No agent data or policy is deleted.

### Check parser behavior

```powershell
node --test ".\tests\openshell-events.test.mjs" ".\tests\conversations.test.mjs" ".\tests\tool-calls.test.mjs" ".\tests\provenance.test.mjs"
```

## Isolated Conversations and Evidence Bundles

### Workflow

1. Start the application with `Start OpenClaw.cmd` and refresh the dashboard.
2. Open **OpenShell > Conversation**.
3. Pick the Single-Action Policy Test and the policy. The task text comes from the catalog and is shown read-only; it is not sent automatically in the manual workflow, so paste it into the chat yourself.
4. Click **New conversation**. The manager creates a dedicated NemoClaw/OpenClaw sandbox using local `qwen2.5:1.5b`, a 32768-token context, a 2048-token output budget, Balanced policy, no messaging/web-search setup, and no direct agent-container GPU access. Ollama remains the host GPU inference service.
5. Wait for Ready. Click **Open isolated chat**, wait for its readiness check, then follow the authenticated link. Each sandbox has its own localhost dashboard port.
6. Use only the **main conversation** inside that conversation sandbox. Enter the actual task in the normal chat composer.
7. The Events tab reads only the sandbox associated with that dashboard origin and immutable sandbox identity.
8. In the same isolated main chat, choose **Conversation > Save task bundle** after the task finishes. The UI shows the local saved folder.

Saving requires a stored main conversation with a completed/idle task (`done` in the observed runtime). It rejects an active task or a session that changes while its trajectory is exported.

Do not use the native New Chat action inside a conversation sandbox for another independent experiment. Use New conversation instead. If another stored conversation is detected, event display and export stop rather than mixing evidence. The shared `my-assistant` application dashboard intentionally shows no conversation-scoped events; it remains the entry point for creating conversations and inspecting its own policy.

### Storage

```text
.local/conversations.json
.local/task-captures/capture-<generated-id>/
  manifest.json
  conversation.json          one Conversation = one Task = one dedicated sandbox
  tool-calls.jsonl           one record per OpenClaw tool call
  task.json
  initial-policy.json
  effective-policy.json
  openshell-events.jsonl
  openshell-log-sanitized.txt
  trajectory/
```

### Tool-call records

Each line of `tool-calls.jsonl` (schema: `safety-router-dataset/create-dataset/schemas/tool-call.schema.json`) links one `tool.call` from the trajectory to:

- the tool name, domain and arguments;
- the policy revision active at the call time (latest revision with `loaded_at_ms` at or before the call) and its snapshot file;
- the OpenShell decision, its rule, and where the decision came from (`openshell.source`);
- the tool result (text capped at 20000 characters, with a SHA-256 of the full text): `is_error` is what OpenClaw reported, `exit_code` is the number in `(Command exited with code N)`, and `status` is `error` when either says the command failed;
- the next OpenClaw assistant message in the same run;
- conversation, session, run and tool-call identifiers and timestamps.

Decision sources differ by domain because OpenShell does not log every domain the same way:

| Domain | Source | Basis |
|---|---|---|
| `exec` command that names `http(s)://` URLs | `observed_event` (attribution `command_url_time_window`) | The same, for each host named in the command, using the events assigned to this call (rules below). The call is labelled only when every host got the same verdict; a call allowed to one host and denied to another is `observed_event_mixed`, has no label, and lists each host under `hosts`. A call whose only event for a host is shared with another call is `observed_event_ambiguous`, has no label, and lists the shared events under `ambiguous_event_ids`. A command that does not name a URL (for example one that reads a hostname from a file) stays `unavailable`. |
| Network tool with a `url` argument | `observed_event` | An ALLOWED/DENIED `NET:` or `HTTP:` event for that host assigned to this call (rules below). Rule is the event's `policy`, `engine` and `reason`. |
| `read`, `write`, `edit` and similar | `derived_from_static_policy` (`verified: false`) | OpenShell logs no filesystem verdict: Landlock is applied once and a blocked access is not logged. The decision is computed from the active `filesystem_policy` (rules are additive) for people to read, and is never exported as a label. `evidence_consistency` compares it with the tool result (for example `EACCES`, which an ordinary Unix permission produces too). Relative paths, and paths covered only by the unknown sandbox workdir, stay `null`. |
| `exec` and other tools | `unavailable` | OpenShell logs process launches, not an allow/deny for a command. Effects inside the command appear as filesystem or network evidence. |

**One event, one call.** An event is a candidate for a call when it is for a host the call names and falls in the call's window: *running* (250 ms before the request until the result) or *grace* (up to 1 s after the result, for late log lines). An event inside exactly one call's running window belongs to that call, even if it is also inside another call's grace. Otherwise, if exactly one call can claim it, it belongs to that call. If several calls can claim it (parallel or overlapping calls to one host) it is **ambiguous**: it is recorded for all of them under `ambiguous_event_ids` and used by none as a label. Bundles saved earlier are re-evaluated with these rules when exported; their `tool-calls.jsonl` is left as saved.

All events in the call window are kept in `candidate_events`, except model inference and gateway traffic. Background agent traffic can appear there and is not attributed to the call unless it matches the requested host. Every record has `ground_truth_verified: false`.

The trajectory export is produced by OpenClaw's native redacted session export. It includes the stored conversation and tool/runtime events as available. Native exports may also contain prompts, tool definitions and artifacts. These remain private local files, excluded from Git. No automatic public export or upload is performed.

### Evidence limits

Sandbox isolation identifies which conversation environment produced an event. It does not prove which individual tool call produced it. Background agent traffic, including telemetry attempts, may still appear. Every normalized event carries `backgroundPossible: true`; bundles state `per_tool_attribution_verified: false` and `ground_truth_verified: false`.

The collector reads a bounded recent history: up to 1000 log records for the live display and 100000 for saving. The manifest discloses that complete historical coverage is not guaranteed. Every stored policy revision is saved with its creation and load times, so several successive policies within one conversation are preserved. Each revision's hash is checked against the listed history. At Save the manifest also records `policy_check`: the effective policy OpenShell reported at conversation creation compared with the one at Save and with the revision history (`unchanged_since_creation`, `later_revisions`, `history_complete`). This shows whether the policy changed during the conversation; it is a consistency check made at Save, not a snapshot taken when any action ran. Bundles saved before this check have no `policy_check` and the field stays `null`. The hash in `effective-policy.json` (default `policy get`) can differ from the revision hash; tool-call records use the revision hash. Do not use an event as a verified policy-conditioned label without checking the exact policy revision and independent evidence.

Previously shared conversations cannot be retroactively isolated or reliably assigned historical OpenShell events. No timestamp-only assignment is used as a fallback. Switching to a different chat route clears the previous view, and unsupported routes show no evidence.

### Deleting a conversation

In **OpenShell > Conversation** on the main dashboard, each conversation card has a **Delete** button (not offered inside a conversation, and not while a sandbox is being created). After you confirm, it destroys that one sandbox with `nemoclaw <id> destroy --yes --no-cleanup-gateway` and removes its record and generated panel files. The shared `my-assistant` sandbox and the gateway are never touched.

Saved task bundles under `.local/task-captures/` are evidence and are kept by default; tick **also delete its saved task bundles** to remove them too (permanent). If the sandbox is still present after the destroy command, its record is kept so you can inspect it. A failed or interrupted entry whose sandbox does not exist is simply removed from the list.
### Saving and closing from inside a conversation

Inside an isolated conversation, its card on the **Conversation** tab offers **Save task bundle** and **Close conversation** (the global save button is hidden: saving is per task). **Delete** is offered there for that conversation only; the main panel can delete any conversation. Close saves the task bundle first and stops the sandbox only if the save succeeded (`nemoclaw <id> stop`; workspace and history are kept). The main panel then marks the card `closed`, and **Open isolated chat** starts it again (`nemoclaw <id> start`). Both buttons work only from the main chat of the conversation after its task has finished.

### Safety Router records

Saving does not derive any Dataset. The Safety Router records are built from the Bundles by `Generate Dataset.cmd` option 2 (`npm run create:dataset`) into a timestamped folder under `.local/safety-router/datasets/` (`accepted-execution-records.jsonl` is the authoritative accepted Dataset). In the Conversation tab each saved Bundle has a **Show complete Agent and OpenShell timelines** button (a read-only `POST /conversations/timeline` that builds the timelines from the Bundle exactly as the exporter does). The GUI has only the Conversation, Policies and Events tabs and no Dataset tab. Formats, acceptance rules and caveats: [docs/dataset/safety-router-dataset.md](dataset/safety-router-dataset.md).

### Updates take effect on the next start

`Start OpenClaw.cmd` hashes the panel service's source files and compares the result with the build hash the running service reports. If they differ, it restarts the service with the new code automatically, and it reinstalls the panel interface in `my-assistant`. Conversations receive the latest interface when you use **Open isolated chat**. Refresh the browser page afterwards. If a conversation sandbox is still being created, the launcher keeps the running service and tells you to start again once creation finishes, so the creation is not interrupted.

### Resource and lifecycle boundaries

Creation is serialized and limited to four ready/creating conversations. Sandboxes reuse the installed managed image where possible but consume additional memory and disk. No sandbox is automatically deleted; you can delete one explicitly (see below). Creation failure or interruption is recorded; the system does not blindly rerun or destroy a possibly existing sandbox. Inspect failed/interrupted resources before recovery.

After a reboot, start Docker and Ubuntu using the launcher, then use Open isolated chat to recover and reapply the side panel. The manager never changes a named shared sandbox into a conversation sandbox. A sandbox whose immutable identity changes is rejected for collection rather than silently reusing its name.

One saved conversation is one Conversation and one dedicated sandbox, and one Safety Router record. An accepted Single-Action Policy Test contains exactly one Tool Call; a Bundle with none, several or a different call is still saved and is excluded from training with its reason. Captures are snapshots; make another Save after later turns to obtain a new bundle.
