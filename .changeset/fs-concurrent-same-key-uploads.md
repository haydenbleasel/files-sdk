---
"files-sdk": patch
---

The fs adapter no longer corrupts or fails concurrent uploads to the same key. Two uploads that landed in the same millisecond shared one staging file, so one of them failed with a spurious `NotFound` from its rename and the survivor's stored etag came from the other call's bytes. Each upload now stages under a per-call unique name, stages its sidecar the same way, and commits both under a per-key lock, so every concurrent upload resolves and the final body and its etag always belong to the same call.
