---
"files-sdk": patch
---

The `files` CLI and `files-sdk/loader` now reject `--provider` names like `toString` or `constructor` with the usual "unknown provider" error. They matched inherited object properties and crashed with "entry.load is not a function".
