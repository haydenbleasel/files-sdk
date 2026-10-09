---
"files-sdk": patch
---

Accept `@googleapis/drive` 25 and 26 as peers of the Google Drive adapter (`files-sdk/google-drive`). Both majors only raise the package's own Node.js floor to 22 (23 and 24 were never published), matching Files SDK 3's Node 22 floor, and the Drive v3 surface the adapter uses is unchanged.
