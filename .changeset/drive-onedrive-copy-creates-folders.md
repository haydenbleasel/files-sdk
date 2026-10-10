---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now create a missing destination folder before `copy()`, so `copy()` and `move()` into a new folder succeed. Before, Graph's copy failed because its destination folder must already exist, even though `upload()` to the same key creates intermediate folders, as copy does on Box, Dropbox, and WebDAV.
