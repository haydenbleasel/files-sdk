---
"files-sdk": patch
---

`files.capabilities` now reports `conditional.create`, `conditional.replace`, `conditional.delete` and every `conditional.copy` flag as `false` when `files-sdk/versioning` is installed, matching the conditional mutations the plugin refuses. Previously it kept advertising the adapter's native support, so callers that branched on the snapshot planned a compare-and-set that then threw. Exact reads (`conditional.exactRead`) still follow the adapter.
