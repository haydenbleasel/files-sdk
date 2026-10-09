---
"files-sdk": patch
---

`copy()` and `move()` on the Box adapter (`files-sdk/box`) now overwrite an existing destination file, as they do on S3 and the other adapters. Box's copy has no overwrite mode, so these calls used to fail with `Conflict`. On that name conflict, the adapter now moves the existing file to the Box trash and copies again. A folder at the destination, or copying a file onto itself, still fails with `Conflict`.
