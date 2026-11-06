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

## Publish later

Before the first commit run `npm run scan:source`: it lists every file Git would include and scans them for secrets and user-specific paths. There is no release workflow: a dataset is published, if ever, only as a separate, deliberately reviewed export, never from `.local/`. The Safety Router records (`.local/safety-router/`) hold task text, Agent messages, tool results and raw-event references; they are redacted of credentials and personal machine paths and an unresolved finding excludes the execution, but they are private like everything under `.local/`. The code and documentation are MIT licensed ([LICENSE](../LICENSE)); the records are not covered by that license.

Install Git for Windows (`winget install Git.Git`) and create an empty repository on GitHub. Open PowerShell in the project folder and run:

```powershell
git init
npm run scan:source
git add .
git status
git diff --cached --stat
```

`.gitignore` excludes `.local/` (saved conversations, bundles, the dataset, panel state), third-party papers (`.local/papers/`), exported policy snapshots and credentials. Confirm none of those appear in `git status`, and review every staged file for secrets and personal information. Then:

```powershell
git commit -m "Add NemoClaw Windows setup, OpenShell panel and dataset tooling"
git branch -M main
git remote add origin https://github.com/<owner>/<repository>.git
git push -u origin main
```

Replace the placeholders. Authenticate through GitHub's supported credential flow; never embed a token in the remote URL. For an existing remote repository, follow its history rather than overwriting it.

Never publish anything from `.local/`: bundles and the dataset files can contain your prompts, file contents and network activity even after redaction. Publish a dataset only as a separate, reviewed export. The MIT license covers the code and documentation, not any dataset. Referenced third-party software and model weights retain their own licenses.

## Maintenance

Verify commands against current NVIDIA documentation. Record versions actually tested and disclose local backports. Updates may replace locally patched files. Distinguish observed results from assumptions when adding new instructions.
