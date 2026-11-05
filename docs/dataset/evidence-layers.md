# Evidence layers

Every execution of a Single-Action Policy Test (and every save in the panel) keeps what OpenShell reported for its Sandbox in two layers, apart from the Dataset. The Safety Router record keeps a complete OpenShell timeline whose events point back to the immutable raw lines (raw_event_reference).

```text
.local/evidence/raw/<run-id>/<execution-id>/         private, exactly as received
.local/evidence/sanitized/<run-id>/<execution-id>/   derived from the raw layer, credentials redacted
```

A save made directly from the panel outside a collection uses `manual` as the run id and `manual-<capture-id>` as the execution id.

## Raw layer (private)

| File | Content |
|---|---|
| `openshell-sandbox.log` | The OpenShell log of the Sandbox, byte for byte as received |
| `openshell-events.raw.jsonl` | One structured record per non-empty log line: time, source, level, target, category (`network`, `http`, `dns`, `process`, `config`, `policy`, `filesystem`, `ssh`, `lifecycle`, `other`, `log`), event type, `decision` and the original line |
| `capture.json` | Capture start and end, OpenShell version, Sandbox, Conversation and Capture ids, line counts, `log_limit_reached` and `evidence_completeness` (`Complete`, or `Truncated` when OpenShell returned the full 100,000 lines and older events may be missing), counts |
| `manifest.json` | SHA-256 and size of every file, counts, `evidence_completeness`, finalization time |

Nothing is dropped: not background traffic, events outside a tool call, ambiguous events, events without a decision, events before the selected policy revision, or events the training schema does not use. "Excluded from training" never means "deleted from evidence". Files are created with the exclusive flag (an existing folder is never overwritten), then made read-only. A later attempt for the same execution moves the earlier folder aside; nothing deletes evidence.

`decision` is `ALLOW` or `DENY` only when OpenShell wrote an explicit `ALLOWED` or `DENIED` verdict right after the severity of an event. The word "denied" in text, an HTTP status or an exit code never sets it.

Raw evidence can contain credentials and private data. It is under `.local/`, which Git ignores. **Do not publish `.local/evidence/raw/`.**

## Sanitized layer

| File | Content |
|---|---|
| `openshell-sandbox.sanitized.log` | The raw log, line by line, with credentials redacted (same number of lines) |
| `openshell-events.sanitized.jsonl` | The structured records with the sanitized line and the SHA-256 of the original line instead of its text |
| `manifest.json` | Sanitizer version and source hash, the raw manifest hash it was derived from, file hashes |

The sanitizer keeps the structure analysis needs (event type, verdict, host, port, binary, policy, reason, path, query parameter names) and removes bearer tokens, authorization and cookie headers, `user:password@` parts, URL fragments, the values of sensitive query parameters and `key=value` credentials, and long opaque identifiers. It writes only under `evidence/sanitized/`; it never overwrites the raw layer. The bundle's `openshell-log-sanitized.txt` is this layer. A Safety Router record carries `integrity.raw_evidence_hash` (the raw manifest hash), `integrity.bundle_manifest_hash` and `integrity.dropped_event_count`, and each timeline event a `raw_event_reference`.

## Checks

The verifier (`verify-single-action-policy-tests.mjs`) re-reads the raw and sanitized manifests, rechecks every file hash, checks that the structured events cover every raw line (none dropped), that the sanitized log has the same number of lines, that the bundle log is the sanitized layer, and that the verdict a record carries is the one in the **raw** line. The collector runs the same kind of checks on every execution before it closes the Sandbox. The log boundaries of the action window are stored outside the evidence, in `.local/runs/<run-id>/boundaries/<execution-id>.json`; they never modify it.
