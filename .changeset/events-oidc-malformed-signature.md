---
"files-sdk": patch
---

`files-sdk/events`: a Google OIDC token whose signature segment isn't base64 is now refused with a `401` ("malformed OIDC token"), before any key fetch. It used to escape as an unexpected error, answered `500` (so Pub/Sub redelivered it) and reported to `onError`.
