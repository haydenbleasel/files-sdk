---
"files-sdk": patch
---

`files-sdk/neon` now throws at construction when only one of `accessKeyId` and `secretAccessKey` is passed. Previously the key that was passed was silently dropped and the adapter fell back to the AWS credential chain, so a half-configured pair (for example, a secret read from an unset environment variable) connected with whatever credentials the environment held instead of failing.
