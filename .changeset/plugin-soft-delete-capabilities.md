---
"files-sdk": patch
---

`files.capabilities` now reports `conditional.delete` as `false` when `files-sdk/soft-delete` is installed, matching the plugin's refusal of a conditional delete outside the trash. Previously it kept advertising the adapter's native support, so callers that branched on the snapshot planned a conditional delete that then threw.
