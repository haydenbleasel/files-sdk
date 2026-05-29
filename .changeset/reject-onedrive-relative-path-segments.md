---
"files-sdk": patch
---

Reject relative path segments in OneDrive and SharePoint delegated paths before building Microsoft Graph item URLs, keeping `rootFolderPath` scoped to its configured folder.
