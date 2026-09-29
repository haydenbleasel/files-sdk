---
"files-sdk": patch
---

`files-sdk/firebase-storage` no longer lets `GOOGLE_APPLICATION_CREDENTIALS` override explicit `credentials`, and it now reads that variable through Application Default Credentials instead of `cert()`. Explicit `serviceAccountPath` and `credentials` options now always win over environment variables, and workload identity federation (`external_account`) and `authorized_user` credential files work instead of crashing at construction.
