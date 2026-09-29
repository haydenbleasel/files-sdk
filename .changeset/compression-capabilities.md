---
"files-sdk": patch
---

`files.capabilities` now reports `signedUrl.supported: false` and `rangeRead: false` when `files-sdk/compression` is installed, matching what the plugin refuses. The `files-sdk/api` gateway picks its download path from these flags, so with the default `downloadMode: "auto"` over a signing adapter it now streams downloads through the instance instead of answering 500, and a `Range` request gets the non-range treatment (416, or the full body with `onUnsupportedRange: "ignore"`) instead of a 500.
