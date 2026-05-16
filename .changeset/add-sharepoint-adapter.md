---
"files-sdk": minor
---

Add SharePoint adapter (`files-sdk/sharepoint`). Resolves `siteUrl` and named `documentLibrary` to a drive via Microsoft Graph, then delegates to the OneDrive adapter for file operations. Falls back to `SHAREPOINT_*` env vars then to `ONEDRIVE_*`. Resolution is lazy and cached after the first call.
