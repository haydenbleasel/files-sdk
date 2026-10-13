---
"files-sdk": patch
---

A plugin failure after a conditional exact read (`download(key, { condition: { etag } })`) is no longer reported as an applied mutation (#176). The conditional dispatcher marked any rejection that followed a successful native call with `applied: true`, so a plugin throwing after the read (for example `files-sdk/encryption` failing to decrypt) reached the caller, `onError`, and `files-sdk/audit` as though the object had changed. A read commits nothing, so that error now comes through unmarked. An `applied` error a plugin raises itself still passes through untouched, and conditional uploads, deletes, and copies are unchanged.
