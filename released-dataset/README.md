# OpenShell Decision Dataset (snapshot 20261106T191411967Z)

51 single-action tests. In each test an OpenClaw Agent made exactly one `web_fetch` tool call to one URL, inside its own OpenShell sandbox, under one unchanged NemoClaw policy tier. The label is OpenShell's own `ALLOWED` or `DENIED` event for that call. Nothing is inferred from HTTP status, exit codes or the Agent's text.

## Contents

- `accepted-execution-records.jsonl`: 51 records, one JSON object per line (about 8.7 MB).
- `manifest.json`: counts, versions, hashes and the build provenance.

The manifest also lists `needs-review-records.jsonl` (5) and `excluded-execution-index.jsonl` (5). Those two files are not published here; the accepted file's SHA-256 in the manifest still matches.

## Numbers

- Training-eligible binary labels: 15 `OPENSHELL_ALLOWED`, 36 `OPENSHELL_DENIED`.
- Policy tiers: restricted 20, balanced 22, open 19.
- Tasks: 18 `web_fetch` destinations, 1 to 6 records each.

## Record fields

- `task`: task id, text, hash and category.
- `applied_policy`: tier name, the complete effective policy OpenShell reported, its hash, and whether it stayed unchanged.
- `outcomes`: three independent results. The OpenShell policy decision (the label, with its evidence status, reason and event ids), the task result, and the action result after OpenShell.
- `agent_timeline`, `openshell_timeline`, `action_and_policy_events`: the evidence for the single action.
- `evaluation_metadata`, `execution_checks`, `routing`: evaluation-only metadata and acceptance checks. Never a model input or a label.
- `timestamps`, `identifiers`, `integrity`: provenance and hashes.

## Limits

- Scope is `web_fetch` only, with one Agent model (`qwen2.5:1.5b`) on OpenShell 0.0.116, OpenClaw 2026.9.2, NemoClaw 0.0.140 and Ollama 0.40.13.
- The manifest states that this export validates the data-collection pipeline and is **not sufficient for training, benchmarking or evaluating a Safety Router**.
- A network decision under a known policy can be reproduced by a deterministic rule evaluator, so these labels alone do not show that a learned model adds value.
- OpenShell does not log filesystem decisions (Landlock is kernel-enforced), so none are present.
- 10 of the records have an unconfirmed action result after OpenShell; their policy decision is still observed.

## License

Code and documentation in the parent repository are MIT licensed. The records in this folder are intended for [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Third-party software and model weights keep their own licenses. Confirm with all authors before publishing.
