---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` now report a key that names a folder as missing. `exists()` returned `true` for a folder path and `head()` returned the folder's metadata as if it were a file. They now return `false` and throw `NotFound`, as the Dropbox and Box adapters do.
