---
"files-sdk": patch
---

Fix error classification in the Bunny Storage adapter (`files-sdk/bunny-storage`) on `@bunny.net/storage-sdk` 0.3.2, which started putting the key into its 400 error message. A rejected request for a key containing words like "not found", "forbidden", or "conflict" was misread as `NotFound`, `Unauthorized`, or `Conflict`; the SDK's own message templates are now matched exactly first, so a 400 stays a `Provider` error whatever the key says.
