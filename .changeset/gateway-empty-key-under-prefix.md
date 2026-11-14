---
"files-sdk": patch
---

The `files-sdk/api` gateway now refuses an empty key with `422` under an `authorize` `keyPrefix` too. It used to resolve to the prefix itself (`users/1/`), so the adapter was asked to head, delete, copy, or sign the caller's whole folder as if it were an object.
