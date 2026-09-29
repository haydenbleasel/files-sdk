---
"files-sdk": patch
---

The `files` CLI now exits with code 2 on a usage error (an unknown flag, a missing required option or argument, an invalid choice). Previously these exited 1, the code the CLI documents for `NotFound` and for `exists` reporting a missing key, so a mistyped flag on `files exists` read as "missing". `--help` and `--version` still exit 0.
