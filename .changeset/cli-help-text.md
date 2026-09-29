---
"files-sdk": patch
---

Corrected the `files` CLI help text. The program description now states the actual number of supported providers (computed from the provider registry) instead of "30+", and `--dry-run` now says it writes nothing rather than claiming it makes no network calls, since `sync --dry-run` still lists both providers to build its plan.
