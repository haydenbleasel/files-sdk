---
"files-sdk": patch
---

`files events parse <path>` given a directory now exits 2 with `Invalid` like the other local file errors, instead of exit 5 with `Provider`, the code that tells a script the backend failed and the command is safe to retry.
