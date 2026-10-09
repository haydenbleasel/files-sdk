---
"files-sdk": patch
---

`files-sdk/compression` now throws `Unsupported` instead of a permanent `Provider` error when `download()` meets an object stored with an algorithm it can't decode (a newer writer's format, or a hand-edited `fscmp_alg` marker). The read can only fail the same way again, so it's a refusal, not a backend failure; the `files-sdk/api` gateway answers it with a `422`.
