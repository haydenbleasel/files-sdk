---
"files-sdk": patch
---

The `files-sdk/api` gateway's `url` operation, and `files-sdk/signed-url-policy`, now accept a requested `responseContentDisposition` as an attachment only when its type is exactly `attachment`. Values such as `attachment, inline`, `attachment inline`, or `attachment/x` passed the old check but render inline in Chromium; they are now replaced with a plain `attachment`.
