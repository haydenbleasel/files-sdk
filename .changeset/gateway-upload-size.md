---
"files-sdk": patch
---

The `files-sdk/api` gateway enforces `maxUploadSize` at both ends of a keyless upload. `presign` now refuses a file whose declared `size` is over the limit with a `422` (`reason: "size"`) before signing anything. The declared size is only advisory, so `complete` still checks the stored object, and when that object is over the token's limit it is now deleted instead of left in storage behind the error entry. The key was minted by the server for that upload alone, so nothing else is touched; a failed removal is reported in the entry's message.
