---
"files-sdk": patch
---

The R2 HTTP adapter now forwards per-operation options (`signal`, and therefore `timeout`) for `copy`, `delete`, `exists`, and `head`. The lazy-loaded proxy over the inner S3 adapter dropped the third argument for those four verbs, so an abort signal never reached the underlying request even though `download`, `list`, and `upload` on the same adapter honored it.
