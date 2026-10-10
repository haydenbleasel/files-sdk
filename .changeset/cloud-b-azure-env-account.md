---
"files-sdk": patch
---

`files-sdk/azure` no longer lets environment credentials for one storage account authenticate an adapter configured for another. Previously, `azure({ container, accountName: "a" })` picked up an `AZURE_STORAGE_CONNECTION_STRING` for account `b`, so data calls went to `b` and SAS URLs were signed with `a`'s name and `b`'s key (a 403). Now an env connection string whose `AccountName` differs from an explicit `accountName` is ignored, and so are `AZURE_STORAGE_ACCOUNT_KEY` and `AZURE_STORAGE_SAS_TOKEN` when `AZURE_STORAGE_ACCOUNT_NAME` (or `AZURE_STORAGE_ACCOUNT`) names a different account. Env credentials for the same account, or that name no account, still apply.
