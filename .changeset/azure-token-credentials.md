---
"files-sdk": patch
---

Add Azure AD / Managed Identity support to the Azure adapter via a `credential` (`TokenCredential`) option. Token-authenticated adapters mint User Delegation SAS URLs for `url()`, `signedUploadUrl()`, and same-container `copy()`, so signed URLs keep working without a storage account key. Set `useUserDelegationSas: false` to opt out of SAS signing for token-only setups.
