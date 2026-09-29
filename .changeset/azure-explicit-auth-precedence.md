---
"files-sdk": patch
---

Explicit auth options passed to `files-sdk/azure` (`connectionString`, `accountKey`, `credential`, `sasToken`) now always win over environment variables: `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_KEY` / `AZURE_STORAGE_KEY`, and `AZURE_STORAGE_SAS_TOKEN` are read only when none of those options is passed. An explicit `endpoint` is also honored when a connection string carries an account key or SAS, instead of being ignored. The missing-credentials error now lists every accepted option and environment variable.
