---
"files-sdk": patch
---

`files-sdk/convex` `upload()` no longer fails after the file is stored when reading its metadata back fails. Previously that error escaped unmapped, and the caller never learned the new storage id, which orphaned the file. Now the upload resolves with the new id and the uploaded content type and size.
