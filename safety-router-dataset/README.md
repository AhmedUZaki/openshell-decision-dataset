# Dataset

Goal: real data to train a **Safety Router**, from one kind of experiment only: the **Single-Action Policy Test**.

```text
Single-Action Policy Test
  -> one Agent tool call
  -> one destination
  -> one unchanged applied policy
  -> one isolated Conversation and Sandbox
  -> complete Agent timeline
  -> complete OpenShell timeline
  -> one Safety Router record
```

A test asks the Agent to perform exactly one tool action (`web_fetch` of one URL), once, inside its own Sandbox under one unchanged policy. OpenShell's own `ALLOWED`/`DENIED` events are the only source of the policy result; nothing is inferred from tool success, exit codes, HTTP status or the Agent's text.

## Workflow

1. `Generate Dataset.cmd`: choose policies (Restricted, Balanced, Open or all three), choose tests (one, several or all of the 12), choose how many independent executions per test and policy, review the calculation, type `RUN`. Every execution gets its own Conversation and Sandbox. It ends by exporting, validating and independently verifying the Safety Router Dataset. Details: [docs/dataset/collecting-data.md](../docs/dataset/collecting-data.md).
2. To try one test by hand, use the OpenShell panel, **Conversation** tab: pick one test and one policy.
3. `Generate Dataset.cmd` option 2 (or `npm run create:dataset`) creates a Dataset from the saved Bundles at any time, in one step: it builds, validates, verifies independently, checks determinism and saves it in a new folder named with its creation time. Bundles are only read; nothing is overwritten.

Output (private, never committed): one folder per Dataset, `.local/safety-router/datasets/safety-router-dataset-<UTC timestamp>/`, holding `accepted-execution-records.jsonl` (the authoritative, complete accepted Dataset; not a model-specific fine-tuning format), `needs-review-records.jsonl`, `excluded-execution-index.jsonl` (a compact index; the evidence stays in the Bundle) and `manifest.json`. Every record states three independent outcomes: the OpenShell policy decision, the task result and the action result after OpenShell. Only Bundles whose saved `task.json` declares `task_type` `single_action_policy_test` are read. Record format, acceptance rules and limits: [docs/dataset/safety-router-dataset.md](../docs/dataset/safety-router-dataset.md).

## Policy

Every Conversation runs under one of NemoClaw's own default tiers with no custom rules ([docs/policies.md](../docs/policies.md)). A record carries the complete effective policy OpenShell reported, its hash and whether it stayed unchanged.

## Files

- `create-dataset/`: `export-single-action-policy-tests.mjs`, `build-dataset.mjs`, `dataset-location.mjs`, `validate-single-action-policy-tests.mjs`, `verify-single-action-policy-tests.mjs`, `schema-validate.mjs` and `schemas/` (`single-action-policy-test-record.schema.json`, plus the `conversation` and `tool-call` schemas of the Bundle files).
- `task-catalog/`: the task catalog ([task-catalog/README.md](task-catalog/README.md)).
- `collect-data/`: `task-catalog.mjs`, `validate-task-catalog.mjs`, `collection-selection.mjs`, `collection-runner.mjs`, `menu.mjs`, `progress-display.mjs`, `system-adapter.mjs` (the code behind `Generate Dataset.cmd`).
- `release-checks/`: `scan.mjs` and `scan-source.mjs`, the secret and path scan (`npm run scan:source`).
Everything under `.local/` is private and ignored by Git.
