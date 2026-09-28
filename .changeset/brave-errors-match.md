---
"files-sdk": patch
---

Match `FilesError` across bundled copies, so a `FilesError` from `files-sdk` thrown in a `files-sdk/api` `authorize` hook maps to its status (e.g. 401) instead of a generic 500.
