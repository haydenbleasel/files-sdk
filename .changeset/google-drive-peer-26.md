---
"files-sdk": patch
---

Accept `@googleapis/drive` 25 and 26 as peers of the Google Drive adapter (`files-sdk/google-drive`). Both majors only raise the package's own Node.js floor to 22 (23 and 24 were never published), and the Drive v3 surface the adapter uses is unchanged, so Node 20 users can stay on 20–22 within the same range.
