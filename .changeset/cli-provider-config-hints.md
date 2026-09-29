---
"files-sdk": patch
---

The `files` CLI's configuration hints now name options the adapters actually read. The `--config-json` examples for Appwrite (`key`, `bucket`), Google Drive (`oauth: {…}`, `rootFolderId`), Box (`oauth`, `ccg`, `jwt` or `developerToken`), OneDrive and SharePoint (`clientCredentials: {…}`) replace flat keys that were ignored, and an Oracle Cloud error for a missing tenancy namespace now explains that it goes in `--config-json`. The registry also records `--region`, not `--endpoint`, as the required flag for Akamai, IBM Cloud Object Storage and Oracle Cloud.
