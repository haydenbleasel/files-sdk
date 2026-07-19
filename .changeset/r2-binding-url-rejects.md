---
"files-sdk": patch
---

`r2()` binding mode: `url()` and `signedUploadUrl()` reject again instead of throwing synchronously on misconfiguration (no hybrid credentials, `responseContentDisposition` without signing). A refactor had made these the only adapter methods that could throw before a `.catch` handler was attached, breaking direct/plugin adapter callers. Also corrects the `R2BindingOptions.bucket` doc comment — it is required for hybrid signing, not an error label.
