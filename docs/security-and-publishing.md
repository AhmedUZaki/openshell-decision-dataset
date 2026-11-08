# Security and GitHub Publishing

## Safe repository content

Keep installation instructions, generic examples, sanitized troubleshooting notes, and tested-version information here.

Never include:

- Gateway tokens or authenticated dashboard URLs.
- API keys, passwords, private keys, certificates, or real `.env` files.
- OpenClaw conversations, workspaces, or runtime configuration dumps.
- NemoClaw/OpenShell credential stores or state directories.
- WSL exports, Docker volumes, model weights, or machine backups.
- Unreviewed logs and screenshots containing personal information.

A real dashboard URL containing `#token=` is a credential. Generate it locally when needed. Keep Ollama's unauthenticated API on loopback and use the managed inference path from the sandbox.

## The public repository

The repository is public: https://github.com/AhmedUZaki/openshell-decision-dataset. The code and documentation are MIT licensed ([LICENSE](../LICENSE)). The records in `released-dataset/` are not covered by that license; their README names the intended terms (CC BY 4.0) and asks that all authors confirm them.

Before every commit, run `npm run scan:source`: it lists every file Git would include and scans them for secrets and user-specific paths. It skips files over 8 MB, so the records file is scanned separately (see below). Then:

```powershell
npm run scan:source
git status
git diff --cached --stat
```

`.gitignore` excludes `.local/` (saved conversations, bundles, the generated Datasets, panel state), third-party papers (`.local/papers/`), exported policy snapshots and credentials. Confirm none of those appear in `git status`, and review every staged file for secrets and personal information. Push with an ordinary `git push`. Authenticate through GitHub's supported credential flow; never embed a token in the remote URL. Never rewrite the history of the public branch unless it is necessary, because everyone who cloned it must then reset.

## Publishing a dataset

Never publish anything from `.local/`. The Safety Router records hold task text, Agent messages, tool results and raw-event references. They are redacted of credentials and personal machine paths, and an unresolved finding excludes the execution, but they stay private like everything under `.local/`: bundles and generated Datasets can contain your prompts, file contents and network activity even after redaction.

A dataset is published only as a separate, deliberately reviewed export. `released-dataset/` is the first one:

1. Copy `accepted-execution-records.jsonl` and `manifest.json` from one timestamped Dataset folder. Do not publish `needs-review-records.jsonl` or `excluded-execution-index.jsonl`.
2. Write a README that states the real counts, the fields, the limits and the license. Check every number against the file.
3. Scan the records file, which `npm run scan:source` skips because of its size:

```bash
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {scanText, privateNames, formatFinding} from './safety-router-dataset/release-checks/scan.mjs'; const f = scanText(readFileSync('released-dataset/accepted-execution-records.jsonl', 'utf8'), {names: privateNames('.'), file: 'accepted-execution-records.jsonl'}); console.log('findings:', f.length); f.forEach(x => console.log(formatFinding(x)));"
```

4. Read a few records by hand, then commit and push.

The MIT license covers the code and documentation, not any dataset. Referenced third-party software and model weights retain their own licenses.

## Maintenance

Verify commands against current NVIDIA documentation. Record versions actually tested and disclose local backports. Updates may replace locally patched files. Distinguish observed results from assumptions when adding new instructions.
