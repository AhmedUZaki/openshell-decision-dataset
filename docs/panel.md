# OpenShell panel

Two parts:

- **The OpenShell panel in the dashboard**: a read-only side panel in the `my-assistant` OpenClaw dashboard for trying the Agent by hand. You chat as usual; the panel shows what the Agent did.
- **The panel service**: the local service behind it. It also creates the isolated conversations (one Sandbox per execution), saves their evidence as Bundles and builds the Safety Router records for `Generate Dataset.cmd`.

## OpenShell panel in the dashboard

`Start OpenClaw.cmd` adds the panel to the `my-assistant` dashboard at `http://127.0.0.1:18789/` (by hand: `Enable-Panel.ps1`; `-Remove` takes it out again). It opens on the right of the chat; **×** hides it and the **OpenShell** button brings it back. It has three tabs:

| Tab | Shows |
|---|---|
| **Agent activity** | The chat in order: your messages, the Agent's replies (and model errors), and every tool call with its arguments, its result, the OpenShell decision logged for it and the OpenShell events during the call. **Latest chat** follows the most recently updated session; the list picks another. **Live** refreshes it every 5 s. |
| **OpenShell events** | The sandbox's recent OpenShell events (network, HTTP, process, filesystem) with ALLOWED/DENIED/OBSERVED. Sandbox-wide: not tied to one call. |
| **Policy** | The policy the sandbox runs: the network policies with their hosts and programs, the filesystem policy, process and Landlock. |

How the activity is read (`POST /agent/activity`, main dashboard origin only): the service lists the sandbox's sessions with `openclaw sessions --json`, exports the chosen one with OpenClaw's own `openclaw sessions export-trajectory` into a fixed temporary folder inside the sandbox (`trajectory-exports/openshell-panel-live`), reads its `events.jsonl` and removes the folder. A session that has not changed is not exported again. Tool calls are matched to OpenShell events with the same rules as saved Bundles ([tool-call records](#tool-call-records)), from the last 3000 sandbox log lines.

What it is not:

- **Read-only.** It changes no policy and saves nothing on Windows. It never touches the isolated `conv-…` sandboxes.
- **Not evidence.** `my-assistant` is shared by every chat, so background traffic can appear. A decision is shown only when OpenShell logged one for that call's host in the call's time window; "No OpenShell decision" means none was logged, not that the call was allowed. Tools without a `url` argument (for example `browser` with `targetUrl`) get no decision. For evidence, use `Generate Dataset.cmd`.
- **Private.** The chat text appears in the browser only; the panel script carries the local capability token, like the service's other clients.

## Panel service

`tools/events-panel/panel-service.mjs` runs on Windows Node.js and binds only to `127.0.0.1:18891`. The dashboard panel reads the live chat from it; the collector calls it over HTTP to create a conversation, save its Bundle, close and delete it. Bulk collection is done with `Generate Dataset.cmd` ([collecting data](dataset/collecting-data.md)).

### Start and stop

`Start OpenClaw.cmd` starts the service (and the rest of the stack). `Generate Dataset.cmd` also needs it running; its preflight checks the service answers at the expected build. To start it by hand after the sandbox is running:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tools\events-panel\Enable-Panel.ps1"
```

To stop it: the same file with `-Remove`. No agent data or policy is deleted.

### Meaning of the OpenShell results

- `DENIED`: the log explicitly contains DENIED.
- `ALLOWED`: the log explicitly contains ALLOWED.
- `OBSERVED`: a logged operation without an explicit decision; this is not proof of allowance.

Configuration records, SSH relays and dashboard loopback noise are excluded. Not every filesystem operation has an individual OpenShell event. Events are sandbox-wide and are not automatically correlated with individual tool calls. They are not verified dataset labels.

### Implementation and boundaries

- The API permits only the expected local origin and requires a random local capability header (kept in `.local/`). Host checks reject DNS rebinding. Mutations additionally require that exact Origin header, JSON input, and explicit confirmation for close and delete. Commands are fixed argument arrays, without a shell or arbitrary executable selection.
- Local runtime state is under `.local/`, ignored by Git. Never upload that folder or raw private logs.
- Common token/password patterns and URL queries/fragments are redacted from stored text. This is a conservative filter, not a complete sensitive-data detector.
- The service source is hashed (`service-files.txt`); `Start OpenClaw.cmd` restarts a service whose build differs from the source on disk, and the collector's preflight checks that the running service has the expected build.

### Check parser behavior

```powershell
node --test ".\tests\openshell-events.test.mjs" ".\tests\conversations.test.mjs" ".\tests\tool-calls.test.mjs" ".\tests\provenance.test.mjs"
```

## Isolated Conversations and Evidence Bundles

### Workflow

For every execution the collector asks the service to:

1. create a dedicated NemoClaw/OpenClaw sandbox (local `qwen2.5:1.5b`, a 32768-token context, a 2048-token output budget, one of NemoClaw's own policy tiers, no messaging/web-search setup, no direct agent-container GPU access; Ollama remains the host GPU inference service). The task text comes from the catalog, never from the caller;
2. send the task to the Agent in the sandbox's main conversation;
3. save the Bundle once the task has finished (a stored main conversation with a completed/idle task; an active task or a session that changes during export is rejected);
4. close and delete the sandbox.

Each conversation has its own localhost dashboard port. If another stored conversation is detected, export stops rather than mixing evidence. The shared `my-assistant` sandbox is never turned into a conversation sandbox and is never touched.

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

Previously shared conversations cannot be retroactively isolated or reliably assigned historical OpenShell events. No timestamp-only assignment is used as a fallback.

### Deleting a conversation

The collector deletes each sandbox after its Bundle is saved (`nemoclaw <id> destroy --yes --no-cleanup-gateway`, through `POST /conversations/delete` with explicit confirmation). The shared `my-assistant` sandbox and the gateway are never touched. Saved task bundles under `.local/task-captures/` are evidence and are kept by default (`deleteBundles: false`). If the sandbox is still present after the destroy command, its record is kept so it can be inspected. A failed or interrupted entry whose sandbox does not exist is simply removed from the list.

### Safety Router records

Saving does not derive any Dataset. The Safety Router records are built from the Bundles by `Generate Dataset.cmd` option 2 (`npm run create:dataset`) into a timestamped folder under `.local/safety-router/datasets/` (`accepted-execution-records.jsonl` is the authoritative accepted Dataset). A read-only `POST /conversations/timeline` builds the full Agent and OpenShell timelines of a Bundle exactly as the exporter does. Formats, acceptance rules and caveats: [docs/dataset/safety-router-dataset.md](dataset/safety-router-dataset.md).

### Updates take effect on the next start

`Start OpenClaw.cmd` hashes the panel service's source files and compares the result with the build hash the running service reports. If they differ, it restarts the service with the new code automatically. If a conversation sandbox is still being created, the launcher keeps the running service and tells you to start again once creation finishes, so the creation is not interrupted.

### Resource and lifecycle boundaries

Creation is serialized and limited to four ready/creating conversations. Sandboxes reuse the installed managed image where possible but consume additional memory and disk. No sandbox is deleted without an explicit request from the collector. Creation failure or interruption is recorded; the system does not blindly rerun or destroy a possibly existing sandbox. Inspect failed/interrupted resources before recovery.

The manager never changes a named shared sandbox into a conversation sandbox. A sandbox whose immutable identity changes is rejected for collection rather than silently reusing its name.

One saved conversation is one Conversation and one dedicated sandbox, and one Safety Router record. An accepted Single-Action Policy Test contains exactly one Tool Call; a Bundle with none, several or a different call is still saved and is excluded from training with its reason. Captures are snapshots.
