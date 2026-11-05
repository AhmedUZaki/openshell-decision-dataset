# Choosing a license

**The owner chose the MIT license** for the code and documentation; the text is in [`LICENSE`](../LICENSE), with the copyright line "The nemoclaw-windows-setup-guide contributors" (no individual name). The options that were compared are kept below for reference.

| Option | What it lets others do | Notes |
| --- | --- | --- |
| **MIT** | Use, copy, modify, merge, publish, distribute and sell the code, including in closed-source products, if they keep the copyright and license notice | Short and permissive. No explicit patent grant. |
| **Apache-2.0** | The same broad freedoms, with notice and change-statement requirements | Includes an **explicit patent grant** from every contributor and a patent-retaliation clause. A little longer; a common choice when contributors or companies are involved. |
| **No public reuse license** (all rights reserved) | Nothing beyond what the law already allows. People may read the public repository but may not reuse it. | **"No license" does not grant public reuse rights.** A public repository without a license is not open source: others may not legally copy, modify or redistribute it. |

## Practical guidance

- Choose MIT for the simplest permissive terms. Choose Apache-2.0 when you want the explicit patent grant.
- Keep all rights reserved if the code should not be reused yet (for example, while the dataset or paper is unpublished).
- The license of the **code** is separate from the terms of a **dataset release**. A dataset built from public web endpoints and OpenShell logs may need its own terms; decide them before publishing any dataset.
- Third-party material keeps its own license. This project does not redistribute NVIDIA source code, model weights or the papers kept under `.local/papers/`.

## Changing the license later

Replace `LICENSE` with the official text of the new license, update the README note, then run `npm run checksums:write` and `npm test`. Copies already published keep the license they were published under.

This page is background information, not legal advice.
