---
"files-sdk": patch
---

`files-sdk/s3-fetch` no longer pairs an `AWS_SESSION_TOKEN` from the environment with keys you pass explicitly. On a Lambda or SSO shell, `s3Fetch()` with static R2 or MinIO keys signed every request with the shell's unrelated token and got a 403. The env token is now read only when `accessKeyId` and `secretAccessKey` also come from the environment; an explicit `sessionToken` still applies.
