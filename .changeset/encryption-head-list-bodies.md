---
"files-sdk": patch
---

`head()` and `list()` results under `files-sdk/encryption` now return plaintext from their body accessors. They already reported the plaintext `size`, but `text()`, `arrayBuffer()`, `blob()` and `stream()` returned the stored ciphertext; they now lazily download the object back through the plugin and decrypt it, so a `cache()` head hit and a miss return the same bytes.
