---
"files-sdk": patch
---

The `downloadFile` tool in `files-sdk/ai-sdk`, `files-sdk/openai`, and `files-sdk/claude` now enforces `maxBytes` on the bytes it actually reads. It used to check only the size `head()` reported and then read the whole body, so an object replaced between the two calls, or a size that under-reported the body, bypassed the cap. The body is now streamed and the download is cancelled with the same `maxBytes` error as soon as it passes the limit.
