---
"files-sdk": minor
---

Add a `validation()` plugin at `files-sdk/validation` — a fail-closed guard that vets writes before any bytes reach the adapter. Enforce a max/min size, an allowed-MIME-type list (exact or `type/*`), and a key-naming rule (a `RegExp` or predicate); the key rule also guards the destination of `copy`/`move`. It transforms nothing and stores no metadata, so reads, `url()`, `copy`, and `move` pass straight through, while `signedUploadUrl()` fails closed when a size or type rule is set (a presigned upload bypasses the plugin). No native dependencies; works on any adapter.
