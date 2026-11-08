# Collecting Single-Action Policy Tests: Generate Dataset.cmd

Collection is done with **`Generate Dataset.cmd`**. It collects one experiment type only: the **Single-Action Policy Test**, which asks the Agent for exactly one tool call, once, against one destination.

```text
Selected Tests  x  Selected Policies  x  Independent Executions  =  Total Executions
```

Every execution is one test, under one policy, in one new Conversation and one new isolated Sandbox.

## The method

```text
Single-Action Policy Test -> one isolated Conversation -> one isolated Sandbox -> one unchanged applied policy
  -> one Agent tool call -> complete Agent timeline -> complete OpenShell timeline
  -> policy result + task completion result -> one Safety Router record
```

Per execution the collector:

1. creates a Conversation and a Sandbox and applies the selected policy; the effective policy is read and saved at creation (`initial-policy.json`);
2. records the log boundary before the task: the time and the number of OpenShell log lines already there (sandbox setup);
3. sends the exact task text from the catalog, once, and waits for the Agent;
4. waits for the OpenShell log to stop growing, then records the finish time and the final line count;
5. saves the raw and sanitized evidence and the Bundle (the effective policy is read again; `effective-policy.json`), verifies them, closes the Sandbox only after that;
6. writes the boundaries to `.local/runs/<run-id>/boundaries/<execution-id>.json`.

The Bundle's `task.json` carries `task_type` and `single_action`, so the exporter can compare what the Agent did with what was declared. After all executions the collector runs the export, validation and independent verification of the Safety Router Dataset (see below).

- The label is OpenShell's own explicit `ALLOW` or `DENY` event, never the exit code, command success, an HTTP status, the Agent's text or a tool result.
- Events without an explicit decision stay in the evidence and in the record's timeline; they never get an invented label.
- Policies are NemoClaw's own defaults. Every execution is independent, so this measures real Agent behavior under each policy; it does not prove the policy is the only variable.

## The menu

`Generate Dataset.cmd` has its own menu (1 Collect new data, 2 Create Dataset, 0 Exit). Option 1 opens the collector menu below.

```text
============================================================
 NemoClaw Safety Router Data Collector
============================================================

1) Start a new collection of Single-Action Policy Tests
2) Resume a previous collection
3) Validate the task catalog
0) Exit
```

Input is checked before anything is created. A malformed answer is explained and asked again; after five bad answers the step ends and nothing has been created.

### 1) Start a new collection

1. **[1/4] Select policies:** Restricted, Balanced (NemoClaw default), Open, or all three.
2. **[2/4] Select Single-Action Policy Tests:** the 12 tests, numbered, each with its tool and URL. Enter `1`, `1,3,5`, `1-4`, or `0` for all. There is no category step and no task-type choice.
3. **[3/4] Select independent executions:** the number of independent executions of each test under each policy (default 1, allowed 1 to 20). Each starts with a new Conversation, a new isolated Sandbox, a new Agent session and a new OpenShell event collection.
4. **[4/4] Review and confirm.**

### Preview, preflight and confirmation

Before anything is created the collector shows, read only: the selection and the calculation (for example `3 Selected Tests x 3 Policies x 2 Independent Executions = 18 Total Executions`), the Conversations, Sandboxes and Bundles that would be created, the **estimated time and storage** (ranges and their basis; estimates are not promises), and the preflight (Docker, WSL, OpenShell, the panel service at the expected source hash, Ollama, NemoClaw's Ollama authentication proxy, the model, the catalog and the selected task ids, versions and hashes, no active collection, sandbox room, evidence directory, Git exclusion of private evidence, disk space, required project files). The preview creates nothing, with one exception: when the Ollama authentication proxy (port 11435) is down after a Windows or WSL restart, the preflight starts it, because every sandbox inference would otherwise fail with HTTP 502 ([troubleshooting](../operations.md)). You must type exactly `RUN`; anything else cancels. The preview expires after five minutes and is bound to the task hashes.

### During the run

A progress display shows the run id, a bar, the stage (Preparing, Creating Conversation, Creating Sandbox, Applying Policy, Waiting for Sandbox, Sending Task, Agent Executing, Stabilizing OpenShell Events, Saving Raw Evidence, Sanitizing Evidence, Saving Bundle, Verifying Bundle, Closing Sandbox, Exporting Dataset, Validating Dataset, Independently Verifying Dataset, Complete), the test, policy and execution, counts of saved Bundles and failures, raw events, explicit ALLOW and DENY, and elapsed and remaining time. **Ctrl+C stops after the execution in progress**; it never interrupts evidence saving.

### Collection status, tool execution outcome and evidence completeness

Different questions are answered separately so a failed task is never recorded as successful just because logs were saved:

| Question | Values |
|---|---|
| Collection status (was the evidence saved, verified and the Sandbox closed?) | Succeeded / Failed |
| Tool execution outcome (how the tool call ended, from its recorded result; stored as `task_outcome` in `execution.json`) | Succeeded / Failed / Partial / Unknown |
| Evidence completeness | Complete / Truncated (OpenShell capture reached its 100,000-line limit) |

The Dataset records its own result names; see [safety-router-dataset.md](safety-router-dataset.md).

### Failure, resume and cleanup

- **Stop conditions.** After the Bundle is saved and verified, the runner judges it exactly as the exporter will. Zero Tool Calls, an extra Tool Call, a wrong tool or wrong arguments (this includes a retry), a changed policy, incomplete or truncated evidence, dropped events or a Bundle that does not verify stop the whole collection at once; the Bundle stays saved and the Sandbox is kept until Resume finalizes the execution. An execution with no explicit OpenShell decision is not a stop condition: it is excluded and the collection goes on. The declared URL must be passed exactly; OpenClaw's own default parameters extractMode and maxChars are allowed, any other extra argument is not.
- If saving or verification fails, that execution is marked failed, **its Sandbox is kept**, partial evidence is kept, nothing later starts, and the run prints how to resume.
- **2) Resume** lists failed, cancelled and interrupted collections, revalidates the task hashes (a changed task blocks the resume), shows what is complete and remains, and needs `RUN` again. It skips executions whose Bundle and both evidence layers verify. An execution that already saved and verified its Bundle and then stopped on a stop condition (for example no Tool Call) is **not run again**: the Agent already acted, so it is finalized. Its Bundle keeps the routing its own assessment gave it (usually excluded), its environment is closed, and the collection continues with the remaining executions. An execution whose evidence is missing or does not verify runs again in a new Conversation and Sandbox; earlier partial evidence is moved aside (`<execution-id>.attempt-N`), never overwritten or deleted. The task is never sent to the Agent twice in one Sandbox. Open the menu with `Generate Dataset.cmd`, then 1, then 2.

### After every execution succeeds

The collector runs one final step, `Creating Dataset`, which is the same command as `npm run create:dataset`:

```text
node safety-router-dataset/create-dataset/export-single-action-policy-tests.mjs
```

That one command builds the Dataset twice (the builds must be identical), validates it, verifies it independently and only then saves the timestamped folder. Nothing is saved if a check fails. `npm run validate:safety-router` and `npm run verify:safety-router` re-check the newest Dataset afterwards.

It never exports after a failed or cancelled collection. The final report lists selected tests, policies, executions, Bundles, raw event totals, explicit decisions, the Safety Router counts (accepted, needs review, excluded, training-eligible; OpenShell decisions ALLOWED, DENIED, missing, ambiguous), duration, disk use and where everything is.

### 3) Validate the task catalog

Runs the catalog validation. A Dataset is created by `Generate Dataset.cmd` option 2 or `npm run create:dataset`; validate and verify it with the npm scripts described below.

## Exporting without collecting

`Generate Dataset.cmd` option 2 (or `npm run create:dataset`) creates a Dataset from the saved Bundles in one step and saves it as `.local/safety-router/datasets/safety-router-dataset-<UTC timestamp>/`. It only reads the Bundles, builds under a temporary name, validates, verifies independently, confirms two builds are identical, and only then renames the folder into place; nothing is overwritten. `npm run validate:safety-router`, `npm run verify:safety-router` and `npm run verify:safety-router:determinism` re-check the newest Dataset at any time and never create one.

## Estimates

Time per execution is the average of earlier finished executions under the same policy, else the task's `estimated_minutes`; a fixed 60 s plus 2 s per execution covers the final steps. Disk is one Sandbox (about 1 GB) plus the average Bundle and evidence size per execution, against the free space (at least 15 GB, or the estimated high storage plus 5 GB, whichever is larger).

## Where things are

| What | Where |
|---|---|
| Bundles | `.local/task-captures/capture-…/` (`execution.json` holds the run, execution, task, version, hash, policy, Conversation, Sandbox and Capture ids; `task.json` holds `task_type` and `single_action`) |
| Raw OpenShell evidence (private) | `.local/evidence/raw/<run-id>/<execution-id>/` |
| Sanitized evidence | `.local/evidence/sanitized/<run-id>/<execution-id>/` |
| Run log, state, report, log boundaries | `.local/runs/<run-id>/` (`run.jsonl`, `state.json`, `report.json`, `boundaries/<execution-id>.json`) |
| Safety Router Dataset | `.local/safety-router/datasets/safety-router-dataset-<UTC timestamp>/` (`accepted-execution-records.jsonl` is the authoritative accepted Dataset) |

Everything under `.local/` is private and excluded from Git. **Never publish `.local/evidence/raw/`**. See [evidence-layers.md](evidence-layers.md).

## Two kinds of reproducibility

**Dataset derivation.** The same saved Bundles deterministically produce the same Safety Router Dataset (`npm run verify:safety-router:determinism`), and the independent verifier re-derives every field from the Bundle with its own code.

**Live experiment.** Re-running a test does not reproduce identical tool calls or outputs: the model is nondeterministic and public endpoints change. The project reproduces the environment and the protocol, not the Agent's behavior.

## Limits that remain

- **Association is by an isolated Sandbox plus saved log boundaries**, not by a per-call identifier. OpenShell's log carries no tool-call id. Because an accepted execution contains exactly one Tool Call in its own Sandbox, events observed in the action window are attributed to that call, but background activity inside the window cannot be excluded with certainty beyond the origin classification.
- Network only: OpenShell logs no filesystem verdict.
- The 1.5B model `qwen2.5:1.5b` is unreliable at tool use: it often makes no call, repeats a call or uses another tool. Many executions will be excluded from training (and kept, with their reasons).
- `openshell logs` is bounded to 100,000 lines; a capture that reaches the limit is Truncated and excluded.
- Tests reach live public endpoints that can change.
- The collector's interaction with a real Sandbox is tested only with mocks in the automated tests.
