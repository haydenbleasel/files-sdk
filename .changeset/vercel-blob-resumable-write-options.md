---
"files-sdk": patch
---

`files-sdk/vercel-blob` resumable and multipart uploads (`control`, `multipart`) now send the adapter's `allowOverwrite` setting and the upload's `cacheControl`, like a plain `upload()` does. Previously a resumable upload to an existing key failed under the default `allowOverwrite: true`, and its `cacheControl` was silently dropped.
