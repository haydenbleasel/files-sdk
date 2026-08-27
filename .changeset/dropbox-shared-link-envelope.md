---
"files-sdk": patch
---

`dropbox({ publicByDefault: true })` now reuses an existing shared link instead of failing with `Conflict`. The Dropbox SDK stores the whole parsed error body on the thrown error, so the `shared_link_already_exists` metadata sits one envelope deeper than the adapter was reading; `url()` on a key whose public link had already been created therefore never found the existing URL and fell through to the generic conflict error. The adapter now reads the enveloped shape (and still tolerates the bare one).
