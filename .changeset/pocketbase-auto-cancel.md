---
"files-sdk": patch
---

`files-sdk/pocketbase` now sends every request with `requestKey: null`, opting out of the PocketBase SDK's auto-cancellation. Concurrent operations on one adapter (two uploads of new keys, two `list()` calls, two downloads or `url()` calls fetching a file token) no longer abort each other with a `Provider` error, and the operation's abort `signal` and `timeout` now reach the request instead of being replaced by the SDK's own controller.
