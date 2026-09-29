---
"files-sdk": patch
---

`files-sdk/box`, `files-sdk/dropbox`, `files-sdk/google-drive`, `files-sdk/onedrive`, and `files-sdk/sharepoint` now map failures when reading the body of a `head()` or `list()` result. If the file was deleted in between, `text()`, `arrayBuffer()`, and `stream()` now fail with a `FilesError` (`NotFound`) instead of the raw SDK error.
