# The Safety Router dataset

The goal is real training data for a Safety Router: a model that, given what an Agent is about to do and the NemoClaw security policy, predicts what OpenShell will decide.

> **Limitation.** A Dataset this small validates only the Data Collection Pipeline. It is not sufficient for training, benchmarking, or evaluating a Safety Router, and it is not ready for training. Each Dataset's `manifest.json` states its actual accepted count, the ALLOWED/DENIED balance and the same limitation (`dataset_limitation`).

The active data comes from one experiment type, the **Single-Action Policy Test**:

```text
Single-Action Policy Test
  -> one Agent tool call
  -> one destination
  -> one unchanged applied policy
  -> one isolated Sandbox
  -> complete, timestamped Agent timeline
  -> complete, timestamped OpenShell timeline
  -> one Safety Router record with three independent outcomes
```

| Step | In this project |
|---|---|
| Input | One Agent tool call (`web_fetch` of one URL) and the complete effective policy OpenShell applied |
| Execution | OpenClaw runs the call inside its own Sandbox, one Sandbox per Conversation; OpenShell enforces the policy |
| Result | Three independent outcomes (below); the OpenShell decision comes only from OpenShell's own explicit `ALLOWED`/`DENIED` events |
| Storage | One Bundle per execution in `.local/task-captures/`; each created Dataset is a timestamped folder under `.local/safety-router/datasets/` |

## Output files

Built by `Generate Dataset.cmd` option 2 or `npm run create:dataset`, which reads the Bundles without modifying them, builds under a temporary name, validates, verifies independently and only then saves the timestamped folder (below). Only **active** Bundles are read: those whose saved `task.json` declares `task_type` `single_action_policy_test`. Any other Bundle is outside the protocol and appears in no file and no statistic. Every active Bundle produces exactly one entry in exactly one file; nothing is dropped silently.

| File | Holds |
|---|---|
| `<dataset folder>/accepted-execution-records.jsonl` | **The authoritative, complete accepted Dataset**: complete, independently verified records whose OpenShell decision is observed and unambiguous (`OPENSHELL_ALLOWED` or `OPENSHELL_DENIED`) and whose action result is confirmed. Not a model-specific fine-tuning format; any trainer-specific conversion must be derived from it |
| `<dataset folder>/needs-review-records.jsonl` | complete records (one compliant Tool Call, Complete evidence, unchanged policy) whose decision is missing or ambiguous, or whose action result cannot be confirmed (for example a DENY with no direct blocking or continuation evidence) |
| `<dataset folder>/excluded-execution-index.jsonl` | a compact index of every structurally invalid, incomplete, truncated, tampered-with or protocol-violating execution; the evidence stays in the referenced Bundle |
| `<dataset folder>/manifest.json` | active statistics only (below) |

Commands: `npm run create:dataset` (the one step above), and for re-checking the newest Dataset at any time: `npm run validate:safety-router`, `npm run verify:safety-router` (independently re-derives every outcome from the Bundle and its raw evidence with its own code; for the index it judges the Bundle again and compares) and `npm run verify:safety-router:determinism` (two builds must be identical and equal to the files of the Dataset). Schema: [`safety-router-dataset/create-dataset/schemas/single-action-policy-test-record.schema.json`](../../safety-router-dataset/create-dataset/schemas/single-action-policy-test-record.schema.json).

### Deterministic export

A record and the manifest hold **no export time**. The output is a pure function of the Bundles, the schema and the source files, so two exports of identical inputs give byte-identical `accepted-execution-records.jsonl`, `needs-review-records.jsonl`, `excluded-execution-index.jsonl` and `manifest.json`, whatever the wall clock says. Evidence timestamps are never replaced by, or mixed with, the time of the export. `manifest.json` carries `dataset_content_hash`, a hash of the three file hashes.

### Timestamped Datasets

There is no un-timestamped copy. Every Dataset is created in ONE step, `Generate Dataset.cmd` option 2 (or `npm run create:dataset`), and is born in its own folder whose name carries the UTC time of its creation, so the date of every Dataset is part of its name:

```text
.local/safety-router/datasets/safety-router-dataset-<YYYYMMDDTHHMMSSmmmZ>/
  accepted-execution-records.jsonl  needs-review-records.jsonl  excluded-execution-index.jsonl  manifest.json
```

Example: `safety-router-dataset-20261104T180530123Z` (UTC, no colon or space; the names sort chronologically, so the newest is the last). The one step builds the Dataset from the Bundles twice (the builds must be identical), validates it, verifies it independently, takes **one** UTC timestamp, and only then renames the finished temporary folder to its timestamped name. Nothing is saved if any check fails, and an existing folder is never overwritten or merged (a same-millisecond collision fails with a clear message; run again).

The manifest alone carries the Dataset's identity: `dataset_snapshot_id` (`Safety Router Dataset 20261104T180530123Z`), `dataset_snapshot_directory` and `dataset_snapshot_created_utc` (`2026-11-04T18:05:30.123Z`), all the same instant. They are operational metadata, not evidence timestamps and not training fields, and they are in no record, label, record hash or the semantic `dataset_content_hash`. Creating two Datasets from the same Bundles gives byte-identical records and the same `dataset_content_hash`; only the folder name and these three fields differ. `validate`, `verify` and the determinism check work on the newest Dataset (or any file list) and never create one.

**Which file is training data.** In every Dataset folder, `accepted-execution-records.jsonl` is the only file with accepted execution records: the authoritative accepted execution-record Dataset from which a model-specific fine-tuning file will be derived later. It is not itself the final fine-tuning representation. `needs-review-records.jsonl`, `excluded-execution-index.jsonl` and `manifest.json` are not training data.

### Excluded index line

```json
{ "record_type": "excluded_single_action_policy_test", "task_id": "", "run_id": "", "execution_id": "", "conversation_id": "",
  "sandbox_id": "", "capture_id": "", "openshell_policy_decision": null, "task_result": "TASK_FAILED",
  "action_result_after_openshell": "OPENSHELL_ACTION_RESULT_NOT_CONFIRMED", "exclusion_reasons": [],
  "bundle_reference": ".local/task-captures/<capture-id>", "raw_evidence_reference": ".local/evidence/raw/<run-id>/<execution-id>" }
```

Exactly these thirteen fields: no Agent timeline, no OpenShell timeline, no policy snapshot, no copied evidence.

### Manifest

`active_records` (`source_bundle_count`, `accepted_count`, `needs_review_count`, `excluded_count`, `training_eligible_count`, `not_training_eligible_count`); `openshell_policy_decisions` (`OPENSHELL_ALLOWED`, `OPENSHELL_DENIED`, `missing`, `ambiguous`); `task_results` (the four task results); `action_results_after_openshell` (the five action results); `training_eligible_binary_labels` (`OPENSHELL_ALLOWED`, `OPENSHELL_DENIED`); `active_policy_profiles`; `active_task_ids`; `active_exclusion_reason_counts`; model and component versions; `project_identity`; `files` (records, bytes, SHA-256 of each file); `dataset_content_hash`; `dataset_limitation`. Only active data is counted. Counts cover all three outputs.

## The three independent outcomes

| Outcome | Question |
|---|---|
| `outcomes.openshell_policy_decision` | What did OpenShell explicitly decide for the evaluated action? |
| `outcomes.task_result` | Did the Agent achieve the declared task objective? |
| `outcomes.action_result_after_openshell` | What happened to the action after OpenShell applied or recorded its decision? |

They are independent and not contradictory. A denied action that was blocked is `OPENSHELL_DENIED` + `TASK_FAILED` + `OPENSHELL_DENIED_ACTION_BLOCKED`: the task failed *because* OpenShell did its job.

```json
"outcomes": {
  "openshell_policy_decision": {
    "value": "OPENSHELL_DENIED",
    "evidence_status": "OPENSHELL_DECISION_OBSERVED",
    "reason": "endpoint api.open-meteo.com:443 is not allowed by any policy",
    "matched_rule": null,
    "event_ids": ["<run>/<execution>/openshell-events.raw.jsonl#line-204:dbdf799b6fa27275"]
  },
  "task_result": { "value": "TASK_FAILED", "reason": "The Tool Call returned an error, so the requested fetch did not complete." },
  "action_result_after_openshell": {
    "value": "OPENSHELL_DENIED_ACTION_BLOCKED",
    "reason": "The tool result shows the proxy refused the tunnel with its own HTTP 403, and no response from the target was observed.",
    "supporting_event_ids": ["<run>/<execution>/openshell-events.raw.jsonl#line-204:dbdf799b6fa27275"]
  }
}
```

### Notation

Everywhere in these documents, `A | B | null` is **shorthand** for "exactly one of these". It is never a value. The schema lists each allowed value individually in an `enum`, and where `null` is allowed the enum holds the real JSON `null`, never the string `"null"`.

### OpenShell policy decision

`value` is `"OPENSHELL_ALLOWED"`, `"OPENSHELL_DENIED"` or JSON `null`. `evidence_status` is `"OPENSHELL_DECISION_OBSERVED"`, `"OPENSHELL_DECISION_MISSING"` or `"OPENSHELL_DECISION_AMBIGUOUS"`. Missing and ambiguous describe the *evidence*, not an OpenShell decision.

| `evidence_status` | `value` | Meaning |
|---|---|---|
| `OPENSHELL_DECISION_OBSERVED` | `OPENSHELL_ALLOWED` or `OPENSHELL_DENIED` | a relevant explicit decision exists and its attribution to the action is sufficiently supported |
| `OPENSHELL_DECISION_MISSING` | `null` | no relevant explicit OpenShell decision exists |
| `OPENSHELL_DECISION_AMBIGUOUS` | `null` | possible relevant decisions exist but attribution or reconciliation cannot be established |

There is no `CONFLICT` and no `NO_DECISION` value. A decision is never inferred from Agent text, task success or failure, a tool error, an HTTP status, a connection observation without an explicit verdict, or timestamps.

### Task Result

`TASK_COMPLETED`, `TASK_FAILED`, `TASK_PARTIALLY_COMPLETED`, `TASK_RESULT_UNKNOWN`. Derived from the declared objective, the Tool Call, its saved result, the final Agent response and the Agent run status; **never from the OpenShell decision**.

| Value | When |
|---|---|
| `TASK_COMPLETED` | the Tool Call succeeded (no error, no HTTP status of 400 or more), the Agent gave a final response, and the run ended successfully |
| `TASK_PARTIALLY_COMPLETED` | the Tool Call succeeded but there is no final response or the run did not end successfully |
| `TASK_FAILED` | the Tool Call returned an error, the target answered with HTTP 400 or more, or no Tool Call was made |
| `TASK_RESULT_UNKNOWN` | the Tool Call has no saved result, or the result does not say whether it succeeded |

### Action Result After OpenShell

`ACTION_PROCEEDED` does **not** mean the task succeeded. It means sufficient saved evidence shows that the evaluated action passed the relevant OpenShell decision point and began execution against its declared target: a request-level (`HTTP:GET`) `ALLOWED` event for the declared method and path, or a successful tool result that carries the target's HTTP status and a final URL on the declared host. A task can still fail after the action proceeded (OpenShell allows, the request reaches the target, the target answers with an error: `OPENSHELL_ALLOWED`, `TASK_FAILED`, `OPENSHELL_ALLOWED_ACTION_PROCEEDED`). It is never concluded from Agent text, task success alone, timestamps alone, the existence of a Tool Call, an unrelated connection event, an ambiguous background event, or a tool result that does not prove the target operation began (a proxy's own `403` refusal is not a target response).

| Value | When |
|---|---|
| `OPENSHELL_ALLOWED_ACTION_PROCEEDED` | the decision is `OPENSHELL_ALLOWED` and the action began against the target (above) |
| `OPENSHELL_ALLOWED_ACTION_DID_NOT_PROCEED` | the decision is `OPENSHELL_ALLOWED` and the tool failed in argument or runtime validation before any request to the target |
| `OPENSHELL_DENIED_ACTION_BLOCKED` | **all** hold: decision `OPENSHELL_DENIED`, attributed to the action; Complete, verified evidence with no dropped events; the Single-Action protocol satisfied; the Tool Call failed and nothing shows the target was reached; **and the saved failed Tool Call result carries the exact proxy tunnel refusal** (below) |
| `OPENSHELL_DENIED_ACTION_PROCEEDED` | decision `OPENSHELL_DENIED` and direct saved evidence that the action reached the declared target (a successful tool result carrying the target's HTTP status and a final URL on its host) |
| `OPENSHELL_ACTION_RESULT_NOT_CONFIRMED` | the decision is missing or ambiguous; the evidence is incomplete, truncated or unverified; the tool result is missing; a DENY exists but there is neither direct blocking nor direct continuation evidence (for example only `fetch failed`, a generic error, a bare cancellation, a non-zero status or a missing response); any other case the evidence cannot settle |

A `DENIED` event plus `TASK_FAILED`, or any generic Tool Call failure, is not enough to claim `BLOCKED`. Neither is free text. A DENY reason text ("not allowed by any policy") establishes a decision, not blocking, continuation or any configuration.

### Effective Applied Policy

The profile name (Restricted, Balanced, Open) is not enough. The record keeps the complete Effective Applied Policy unchanged (`applied_policy.policy_snapshot`, its hash, and whether it stayed unchanged), including the original `enforcement` values of its endpoint rules. The record exposes **no** derived mode, setting or configuration field: what happened to the action is described by `outcomes.action_result_after_openshell` alone. Where a rule says `enforce` or `audit`, that original value stays in the snapshot only; no code derives a mode from it or from a denial reason.

### Direct blocking evidence (one exact signature)

For the current `web_fetch` network actions there is exactly one accepted signature, named internally `proxy_tunnel_403_refusal` (not exported). When the OpenShell proxy refuses the HTTPS tunnel, OpenClaw's failed tool result is a JSON object `{ "error": "...", "status": "error" }` whose `error` is a chain of ` | `-separated parts such as `fetch failed | Request was cancelled | 0 | Proxy response (403) !== 200 when HTTP Tunneling | UND_ERR_ABORTED`. The signature is the **whole part** `Proxy response (403) !== 200 when HTTP Tunneling` inside the `error` of a failed Tool Call result; the other parts are optional. It is **not** accepted in prose, in a quotation, in Agent messages, in the final response, in target content, in an OpenShell event, without the tunnelling context, or in a result that did not fail.

Not blocking evidence by themselves: a generic HTTP 403, `Proxy response (403) !== 200` without the tunnelling context, `fetch failed`, `request failed`, a bare `Request was cancelled` or `UND_ERR_ABORTED`, phrases such as `blocked by policy`, `denied by proxy` or `refused by policy`, task failure, an Agent explanation, or the absence of a target response. Such results are `OPENSHELL_ACTION_RESULT_NOT_CONFIRMED` and go to review. A further genuine signature must be added as its own named, tightly structured check with a positive fixture from the real format, negative fixtures for similar text, and an independent implementation in the verifier; never as a broad regular expression. Limitation: a hostile target cannot place this part in the proxy's error chain, but the check trusts the structure of the saved runtime result.

### Event-to-action attribution

OpenShell's log carries no request id, so attribution is by isolation and boundaries. An explicit decision is attributed to the action **only when all** hold:

- the execution had its own Conversation and its own Sandbox;
- exactly one Tool Call was attempted, with the exact declared tool, arguments and destination;
- the event is inside the saved execution boundaries (log lines and times) and is the Agent's own network or HTTP activity, not setup, model inference or platform activity;
- the event's destination (host and port) matches the declared target; a request-level event also matches the declared method and path;
- no other candidate could explain it: no decision for another destination during the action, and no background or unclassified event with a decision for the same destination in the same window;
- the Bundle evidence is Complete, verified, with no dropped events, and the policy is unchanged.

Timestamps help place an event in the window but never establish attribution by themselves. This is **not** direct, per-request attribution; there are no confidence levels and no `verified` field. If attribution is uncertain the value is `null`, the status is `OPENSHELL_DECISION_AMBIGUOUS`, the action result is `OPENSHELL_ACTION_RESULT_NOT_CONFIRMED`, and the record goes to `needs-review-records.jsonl` (or to the excluded index when the evidence itself is unusable). No binary label is produced.

### Enforcement-layer resolution

Decisions are resolved by request scope and enforcement-layer specificity, not by "the last event":

- a request-level (`HTTP:GET`) decision for the declared method and path is more specific than the connection-level (`NET:OPEN`) decision: `NET:OPEN ALLOWED` followed by `HTTP:GET DENIED` is **`OPENSHELL_DENIED`**, not an ambiguity (the connection was allowed, the specific operation was denied);
- a connection-level `DENIED` together with any request-level event contradicts itself: ambiguous;
- decisions at the same layer that disagree, decisions for another destination, and request-level decisions for another method or path: ambiguous;
- no explicit decision during the action: missing.

### Evaluation metadata

`evaluation_metadata` holds `action_policy_behavior`, `attribution_basis` and a `note`. `action_policy_behavior` is `COMPLIANT_ACTION` (the evaluated action was explicitly allowed), `PROHIBITED_ACTION_ATTEMPTED` (explicitly denied) or `ACTION_POLICY_BEHAVIOR_UNKNOWN`. It describes only this single action, not the Conversation.

### Training labels and data leakage

The Safety Router relationship is *Action + Effective Applied Policy → ALLOW or DENY*. Only `OPENSHELL_ALLOWED` and `OPENSHELL_DENIED` can become binary labels, and only from a record that is accepted (observed and unambiguous decision, Complete evidence, preserved policy, protocol satisfied, independently verified). Task Result, Action Result After OpenShell, Agent behavior, the decision evidence status and everything observed after the action are **evaluation metadata only**: never a Router input, never a label. This prevents post-action data from leaking into the Router input.

## One record

```json
{
  "record_type": "single_action_policy_test_record",
  "task": { "task_id": "", "task_text": "", "task_hash": "", "task_category": "single-action-policy-tests" },
  "applied_policy": { "policy_profile": "balanced", "policy_snapshot": {}, "policy_hash": "", "policy_remained_unchanged": true },
  "timestamps": {},
  "agent_timeline": [],
  "openshell_timeline": [],
  "action_and_policy_events": {
    "agent_action": {}, "events_observed_during_action": [], "events_outside_action": [],
    "association_method": "isolated_sandbox_single_action_with_log_boundaries"
  },
  "outcomes": { "openshell_policy_decision": {}, "task_result": {}, "action_result_after_openshell": {} },
  "evaluation_metadata": { "action_policy_behavior": "", "attribution_basis": "", "note": "" },
  "execution_checks": { "evidence_collection_status": "Succeeded", "agent_instruction_compliance": "Passed", "tool_execution_status": "Failed", "evidence_completeness": "Complete", "policy_remained_unchanged": true },
  "routing": { "output": "accepted", "training_eligible": true, "reasons": [] },
  "identifiers": { "run_id": "", "execution_id": "", "conversation_id": "", "sandbox_id": "", "capture_id": "" },
  "integrity": { "bundle_manifest_hash": "", "raw_evidence_hash": "", "record_hash": "", "dropped_event_count": 0 }
}
```

A record **never contains** `policy_version`, `link_confidence`, `verified`, `caused_by_action`, a confidence level (`High`, `Medium`, `Low`), the earlier `policy_result` / `execution_results` blocks, or any expected decision. The validator and the independent verifier reject these keys and values.

### applied_policy

One policy snapshot per execution. `policy_snapshot` is the complete effective policy OpenShell reported (`policy get --full`), including the rules OpenShell and NemoClaw compose. The policy is read once when the Sandbox is created (before the task is sent, `initial-policy.json`) and again when the Bundle is saved (`effective-policy.json`); the record's snapshot is the one read at save, and its hash is compared with the first. `policy_hash` is the canonical hash (the per-sandbox provider id is normalized so hashes compare across sandboxes). `policy_remained_unchanged` is false if the two hashes differ, if the Bundle's policy check reports a change or several revisions, or if the policy fingerprint (OpenShell's hash of the effective policy) read just before the task and just after the Agent finished (`policy_before` and `policy_after` in `.local/runs/<run>/boundaries/<execution>.json`) differ from each other or from the one read when the Sandbox was created; an unreadable fingerprint is `null`, never invented; such an execution is preserved and excluded. Revisions are never combined.

### timestamps and timestamp preservation

Original timestamps are preserved exactly as saved, with their source, and never normalized, rounded, reordered or replaced. `timestamps` holds, each as `{ "value", "source" }`: `conversation_created`, `sandbox_created`, `sandbox_ready`, `task_dispatched`, `tool_call_requested`, `tool_call_started`, `tool_call_completed`, `tool_result_recorded`, `final_agent_response`, `agent_run_ended`, `execution_boundary_start`, `execution_boundary_end`, `evidence_saved`, `policy_snapshot_created`, `policy_snapshot_loaded` (epoch milliseconds, as saved, from the policy revision the snapshot belongs to), and `timeline_sources`. A timestamp that was never saved is `{ "value": null, "source": "not_recorded" }`: today that is `sandbox_created` and `sandbox_ready`. A missing timestamp is never replaced by the export time or invented.

Agent events keep the trajectory's own `ts` string. Every OpenShell event keeps `source_timestamp`, the epoch text of its log line exactly as OpenShell wrote it (for example `1793817064.193`), and `timestamp_utc`, the same instant in UTC with the same millisecond precision. Every user message, Agent message, Tool Call start, tool result, final response and run end is a timeline entry with its timestamp.

### agent_timeline

Every available Agent event in trajectory order, numbered with `sequence` and the exact `timestamp_utc`: `task_received`, `assistant_message`, `tool_call_started` (`tool_call_id`, `tool_name`, `arguments`), `tool_call_finished` (`tool_result` with `text` and `is_error`, and `tool_execution_status` of Succeeded, Failed or Unknown), `final_agent_response` (the last Agent message), `agent_run_ended` (`agent_run_status`) and `runtime_message` (non-task user messages). Missing values are `null`; nothing is invented. Text is redacted of credentials and personal machine paths. `action_and_policy_events.agent_action` adds `requested_at_utc` and `result_recorded_at_utc` from `tool-calls.jsonl`.

### openshell_timeline

Every OpenShell event of the Sandbox, including events without a decision (setup, model inference, telemetry, background), in the original order:

```json
{ "sequence": 1, "timestamp_utc": "", "source_timestamp": "1793817064.193", "raw_event_reference": "<run>/<execution>/openshell-events.raw.jsonl#line-N:<sha256 prefix>",
  "event_type": "NET:OPEN", "decision": null, "reason": null, "matched_rule": null,
  "event_origin": "sandbox_setup_activity", "destination": { "host": "", "port": 0 }, "http_method": null, "http_path": null }
```

`sequence` is the 1-based position among non-blank log lines; the raw reference points to the immutable raw line. `decision` is `ALLOW` or `DENY` only for an explicit `ALLOWED`/`DENIED` event, otherwise `null`. `destination`, `http_method` and `http_path` are read from the event.

`event_origin` is one of:

| Value | Assigned when |
|---|---|
| `sandbox_setup_activity` | the event is at or before the log line count recorded just before the task was sent |
| `model_inference_activity` | the destination is `inference.local` |
| `platform_background_activity` | the destination is `host.openshell.internal`, or the event is a config, ssh, lifecycle, policy or plain log line |
| `agent_task_activity` | a sandbox network or HTTP event towards any other destination |
| `unclassified_activity` | everything else |

### Action window: events_observed_during_action and events_outside_action

Before sending the task the runner records the task start time and the raw log line count; after the Agent finishes and the log stops growing it records the finish time and the final line count (`.local/runs/<run>/boundaries/<execution>.json`).

An event is in `events_observed_during_action` only when **all** hold: it comes from the same Sandbox (each Sandbox is isolated); its line number is after the first boundary and not after the final one; its time lies between the start of the Tool Call and the task finish time (the documented log-stabilization boundary); and its origin is `agent_task_activity`. Every other event is in `events_outside_action`. Each OpenShell event appears exactly once, in one of the two lists. The name is factual: it says when the event was observed; whether it can be attributed to the action is decided by the attribution rules above.

### execution_checks and routing

`execution_checks`: `evidence_collection_status` (Succeeded, Failed), `agent_instruction_compliance` (Passed, Failed, Unable to Determine), `tool_execution_status` (Succeeded, Failed, Unknown), `evidence_completeness` (Complete, Truncated, Incomplete), `policy_remained_unchanged`. `routing`: `output` (`accepted`, `needs_review`, `excluded`), `training_eligible` (true only for `accepted`) and `reasons`.

## Routing rules

A record is **accepted** only when all hold:

- one isolated Conversation and one isolated Sandbox are recorded;
- exactly one Tool Call occurred, with the declared tool and the declared arguments, no retry and no additional tool;
- one applied policy was saved and remained unchanged;
- the evidence is Complete and the dropped-event count is zero;
- the Bundle verifies (raw and sanitized evidence, manifests) and its declaration (`task_type`, `single_action`) and log boundaries were recorded;
- the OpenShell decision is observed and unambiguous (`OPENSHELL_ALLOWED` or `OPENSHELL_DENIED`) and the action result is confirmed;
- no unresolved secret or personal path remains (if one does, the text is withheld and the execution is excluded).

A record that meets all of those except the last two decision conditions goes to **`needs-review-records.jsonl`**: the decision is missing or ambiguous, or the action result after OpenShell is not confirmed (for example a DENY with no direct blocking or continuation evidence, a generic Tool Call failure, or a missing tool result). Every other execution is preserved and **excluded** with reasons: no Tool Call; more than one Tool Call; wrong tool or arguments; changed policy; Truncated or Incomplete evidence; dropped events; failed Bundle verification; missing boundaries or declaration.

## What the current Dataset contains

The size and balance of a Dataset are reported in its `manifest.json` (`active_records`, `training_eligible_binary_labels`, the OpenShell decision counts). The records are re-derived from the saved Bundles, so the same Bundles always give the same Dataset. A Dataset of a few dozen records validates only the Data Collection Pipeline. It is far too little to train, benchmark or evaluate a Safety Router.

## Filesystem decisions: not available

OpenShell does **not** log filesystem ALLOW/DENY decisions. Its log classes are network (`NET:`, `HTTP:`), process (start/exit only), SSH, config, lifecycle, findings, auth and API. Landlock is enforced by the kernel and a blocked access is not logged. The active experiment is therefore network only.

## Training format

Prompt: the Agent action (tool and arguments) and `applied_policy.policy_snapshot`. Completion: `outcomes.openshell_policy_decision.value` of an accepted record (`OPENSHELL_ALLOWED` or `OPENSHELL_DENIED`; `reason` and `matched_rule` if wanted). Keep the timelines, outcomes other than the decision, evaluation metadata, identifiers and `integrity` out of the prompt: they describe what happened after the decision. Split by `task.task_id`, never by line.

## Bundle layout

```text
.local/task-captures/<capture-id>/
  manifest.json  task.json  execution.json  conversation.json  environment.json
  initial-policy.json  effective-policy.json
  openshell-events.jsonl  openshell-log-sanitized.txt
  tool-calls.jsonl  trajectory/
```

`task.json` carries `task_type` and `single_action`. The raw and sanitized evidence is outside the Bundle: see [evidence-layers.md](evidence-layers.md). `.local` is ignored by Git; raw captures can contain private task text and prompts. Bundles also contain the `verified` and `ground_truth_verified` fields of the Bundle evidence format; they are evidence-format fields, not Dataset-record fields.

## Limits: read before training

- **Association is by isolated Sandbox plus log boundaries**, not by a per-call identifier: OpenShell's log carries no tool-call id. With exactly one Tool Call per accepted execution and every attribution condition above met, the decision is sufficiently supported; it is not direct per-request attribution. The process identity of an event is not used.
- **Few and skewed examples.** Check the accepted count and the ALLOWED/DENIED balance in `manifest.json` before training: a handful of executions does not change a model. Many tests will be denied by Restricted; check the number of distinct matched rules too.
- **The tool-result heuristics are deliberately narrow.** "Response from the target" needs the target's HTTP status and a final URL on the declared host in a successful tool result; "failed before proceeding" needs an explicit validation error text. Anything else is `OPENSHELL_ACTION_RESULT_NOT_CONFIRMED` and goes to review.
- **`qwen2.5:1.5b` is unreliable at tool use** (no call, repeated calls, other tools, claims of requests it never made). Such executions are kept and excluded; expect a low acceptance rate.
- **Network only**, and live endpoints change over time.
- **Private.** The files can contain prompts and tool output even after redaction.
