---
"files-sdk": patch
---

A conditional `upload()` in `files-sdk` whose write committed but whose adapter returned a malformed or weak ETag now rejects with `applied: true`. Before, the post-commit ETag check failed the call as a plain provider error, hiding that the object had already changed.
