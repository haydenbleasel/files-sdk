---
"files-sdk": patch
---

`files.capabilities` now reports every `conditional` flag as `false` when `files-sdk/tiering` is installed, matching the plugin's refusal of every conditional operation. Previously it kept advertising the hot adapter's native support, so callers that branched on the snapshot planned a compare-and-set that then threw.
