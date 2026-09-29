---
"files-sdk": patch
---

`copy()` in `files-sdk/azure` now works with a `credential` and `useUserDelegationSas: false`. The copy source is authorized with the credential's bearer token, where it was previously sent unauthenticated and rejected for private containers.
