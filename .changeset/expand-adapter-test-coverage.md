---
"files-sdk": patch
---

Expand adapter test coverage for error-recovery branches that were previously unexercised: `exists()` swallowing a thrown `NotFound` (azure, gcs, netlify-blobs, r2) versus rethrowing other mapped errors; the supabase stream-download error envelope; and dropbox's `exists()` returning false for `folder`/`deleted` `.tag`s plus the `shared_link_already_exists` recovery falling through when no usable URL is embedded. No runtime behavior changes.
