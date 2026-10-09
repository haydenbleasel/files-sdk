---
"files-sdk": patch
---

The bulk `head-many`, `exists-many`, and `delete-many` operations on the `files-sdk/api` gateway no longer start when the client has already disconnected: they now check the request's abort signal before touching storage, as the single-key operations do. (A batch already under way still runs to the end, since the SDK's bulk methods take no per-call signal.)
