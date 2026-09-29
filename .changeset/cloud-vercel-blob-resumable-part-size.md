---
"files-sdk": patch
---

`files-sdk/vercel-blob` resumable uploads now slice a resumed upload on the part size pinned in the `UploadControl` token, as the S3 and Azure adapters do. A resume with a different (or default) `multipart.partSize` used the new size, which misaligned with the parts the token already held.
