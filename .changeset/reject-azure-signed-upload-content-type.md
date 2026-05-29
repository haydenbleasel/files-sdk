---
"files-sdk": patch
---

Reject Azure signed upload `contentType` overrides because Azure SAS URLs do not bind the request Content-Type into the signature.
