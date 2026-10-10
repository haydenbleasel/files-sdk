---
"files-sdk": patch
---

`files-sdk/client` now classifies error responses that don't come from the gateway by HTTP status, and says why. A body such as Supabase's `{ "error": "InvalidJWT", "message": "jwt expired" }` used to be read as the gateway's envelope and became a `Provider` error with an empty message, and a `401` from auth middleware in front of the gateway became a generic `Provider` error. Only a body whose `error.code` is a string is now treated as the envelope. Anything else maps `401`/`403` to `Unauthorized`, `404` to `NotFound` and `409`/`412` to `Conflict` (else `Provider`), and the message keeps the old `gateway responded 401` or `upload failed (403)` prefix with the body's reason appended when it has one.
