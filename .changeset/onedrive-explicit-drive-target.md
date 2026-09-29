---
"files-sdk": patch
---

`files-sdk/onedrive` now reads the `ONEDRIVE_DRIVE_ID` / `ONEDRIVE_SITE_ID` / `ONEDRIVE_USER_ID` env targets only when no `driveId`, `siteId`, or `userId` option is passed. An explicit target plus an unrelated env target used to throw "pass at most one", and since `files-sdk/sharepoint` always passes the resolved `driveId`, any of those env vars broke every SharePoint adapter.
