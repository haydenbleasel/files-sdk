---
"files-sdk": patch
---

`files-sdk/azure` now reports `signedUrl.supported: false` when it has no signer (SAS-only, anonymous, or `credential` with `useUserDelegationSas: false`), where `url()` and `signedUploadUrl()` always throw. Previously it always reported `true`.
