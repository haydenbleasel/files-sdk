---
"files-sdk": patch
---

Reject Google Drive, OneDrive, and SharePoint signed upload `maxSize` and `minSize` options because their upload sessions cannot enforce a server-side content-length policy.
