# OpenShell Decision Dataset (snapshot 20261106T191411967Z)

51 single-action tests. In each test an OpenClaw Agent made exactly one `web_fetch` tool call to one URL, inside its own OpenShell sandbox, under one unchanged NemoClaw policy tier. The label is OpenShell's own `ALLOWED` or `DENIED` event for that call. Nothing is inferred from HTTP status, exit codes or the Agent's text.

## Contents

- `accepted-execution-records.jsonl`: 51 records, one JSON object per line (about 8.7 MB).
- `manifest.json`: counts, versions, hashes and the build provenance.

The manifest also lists `needs-review-records.jsonl` (5) and `excluded-execution-index.jsonl` (5). Those two files are not published here; the accepted file's SHA-256 in the manifest still matches.

## Numbers

- Training-eligible binary labels: 15 `OPENSHELL_ALLOWED`, 36 `OPENSHELL_DENIED`.
- Policy tiers: restricted 19, balanced 15, open 17.
- Tasks: 18 `web_fetch` URLs on 15 hosts, 1 to 6 records each. Twelve are in the current task catalog; six come from tests removed from it later (`fetch-example-http`, `fetch-httpbin-json`, `fetch-ip-address`, `fetch-openclaw-documentation`, `fetch-unusual-port`, `fetch-wikipedia-article`). Their records stay valid and in the dataset.
- Every record has an observed OpenShell decision, a confirmed action result (36 `OPENSHELL_DENIED_ACTION_BLOCKED`, 15 `OPENSHELL_ALLOWED_ACTION_PROCEEDED`), and its own sandbox and conversation.
- `manifest.json` counts all 61 source bundles (for example 22/19/20 policy tiers and 10 records without a confirmed action result); this file holds only the 51 accepted ones.

## What is inside `accepted-execution-records.jsonl`

One line is one complete test: one Agent, one `web_fetch` call, one destination, one policy. The file is large (about 170 KB per record) because each record carries the full evidence, not only the label.

Top-level keys of every record:

- `record_type`: always `single_action_policy_test_record`.
- `task`: `task_id` (for example `fetch-weather-api`), `task_text` (the exact prompt given to the Agent, including the URL), `task_hash`, `task_category`.
- `applied_policy`: `policy_profile` (`restricted`, `balanced` or `open`), `policy_snapshot` (the complete effective OpenShell policy: filesystem, Landlock and every network policy with its binaries, endpoints and rules), `policy_hash`, `policy_remained_unchanged`. Most of the file size is this snapshot.
- `action_and_policy_events`: `agent_action` (the one tool call: `tool_call_id`, `tool_name`, `arguments.url`, request, start, finish and result times), `events_observed_during_action` (the OpenShell events inside the action window, for example `NET:OPEN` with `ALLOW` or `DENY`), `events_outside_action` (every other OpenShell event of that sandbox, such as setup), and `association_method`.
- `agent_timeline`: the ordered Agent events (task received, tool call, tool result, final answer), each with `sequence`, `timestamp_utc`, `event_type` and `content`.
- `openshell_timeline`: all OpenShell events of the sandbox in order (226 to 252 per record). Each has `sequence`, `timestamp_utc`, `raw_event_reference`, `event_type`, `decision`, `reason`, `matched_rule`, `event_origin` (`sandbox_setup_activity`, `agent_task_activity`, `platform_background_activity` or `unclassified_activity`), `destination`, `http_method` and `http_path`. Most events are sandbox setup activity.
- `outcomes`: three independent results.
  - `openshell_policy_decision`: `value` (`OPENSHELL_ALLOWED` or `OPENSHELL_DENIED`) is the label. It also has `evidence_status`, `reason` (for a denial, for example that the endpoint is not allowed by any policy), `matched_rule` (the policy that allowed it) and `event_ids`.
  - `task_result`: `TASK_COMPLETED`, `TASK_FAILED`, `TASK_PARTIALLY_COMPLETED` or `TASK_RESULT_UNKNOWN`, with a reason.
  - `action_result_after_openshell`: for example `OPENSHELL_ALLOWED_ACTION_PROCEEDED` or `OPENSHELL_DENIED_ACTION_BLOCKED`, with a reason and supporting event ids.
- `evaluation_metadata`: `action_policy_behavior` and `attribution_basis`. For evaluation only. Never a model input and never a label.
- `execution_checks`: evidence collection, instruction compliance, tool execution status, evidence completeness, and whether the policy stayed unchanged.
- `routing`: `output` (`accepted` for every record here), `training_eligible` and `reasons`.
- `timestamps`: the times of conversation, task dispatch, tool call, result, final answer and evidence saving. Each has a `value` and the `source` it came from; `value` is `null` when it was not recorded (sandbox creation times are never recorded).
- `identifiers`: `run_id`, `execution_id`, `conversation_id`, `sandbox_id`, `capture_id`.
- `integrity`: `bundle_manifest_hash`, `raw_evidence_hash`, `record_hash` and `dropped_event_count`.

Inputs and labels. The model input for the planned Safety Router is the tool call (`action_and_policy_events.agent_action`) together with `applied_policy`. The label is `outcomes.openshell_policy_decision.value`. Everything else is evidence or evaluation metadata and must not be given to the model.

Read the label of every record:

```bash
node -e "for (const l of require('fs').readFileSync('accepted-execution-records.jsonl','utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); console.log(r.task.task_id, r.applied_policy.policy_profile, r.outcomes.openshell_policy_decision.value); }"
```

## Limits

- Scope is `web_fetch` only, with one Agent model (`qwen2.5:1.5b`) on OpenShell 0.0.116, OpenClaw 2026.9.2, NemoClaw 0.0.140 and Ollama 0.40.13.
- The manifest states that this export validates the data-collection pipeline and is **not sufficient for training, benchmarking or evaluating a Safety Router**.
- A network decision under a known policy can be reproduced by a deterministic rule evaluator, so these labels alone do not show that a learned model adds value.
- OpenShell does not log filesystem decisions (Landlock is kernel-enforced), so none are present.

## License

Code and documentation in the parent repository are MIT licensed. The records in this folder are intended for [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Third-party software and model weights keep their own licenses. All authors must confirm these terms.
