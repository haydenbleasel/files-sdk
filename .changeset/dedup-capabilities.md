---
"files-sdk": patch
---

`files.capabilities` now reports `signedUrl.supported: false` and every `conditional` flag as `false` when `files-sdk/dedup` is installed, matching what the plugin refuses; `rangeRead` still follows the adapter. The `files-sdk/api` gateway picks its download path from these flags, so with the default `downloadMode: "auto"` over a signing adapter it now streams downloads through the instance (with `Range` support) instead of answering 500.
