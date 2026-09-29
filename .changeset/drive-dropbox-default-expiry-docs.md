---
"files-sdk": patch
---

The `defaultUrlExpiresIn` JSDoc in `files-sdk/dropbox` now says that a default above 14400 seconds is capped to Dropbox's 4-hour link lifetime. It used to say such values throw, but only a per-call `expiresIn` above 14400 throws.
