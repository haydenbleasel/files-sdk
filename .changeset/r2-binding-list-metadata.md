---
"files-sdk": patch
---

Request `httpMetadata` and `customMetadata` when listing through the R2 Workers binding, so list() reports the stored content type and metadata instead of `application/octet-stream` and `undefined`. Completes #116 for the binding path (#128 covered the S3/HTTP paths), and with exact stored values rather than extension inference, since the binding API offers them.
