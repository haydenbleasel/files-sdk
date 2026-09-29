---
"files-sdk": patch
---

`files-sdk/nitro` now serves requests Nitro handles in-process, such as the edge preset's `localFetch` and an SSR `$fetch` to your own API. They used to fail with a `500`, because the mock request Nitro builds has no socket and keeps its body on the event. The binding now uses the event's Web `Request` when h3 provides one, and otherwise reads the body where h3 stores it.
