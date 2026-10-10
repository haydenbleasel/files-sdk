---
"files-sdk": patch
---

`files-sdk/dropbox` now strips `rootFolderPath` from listed keys regardless of case. Dropbox paths are case-insensitive, so with `rootFolderPath: "uploads"` and a real folder named `/Uploads`, `list()` used to return keys like `Uploads/a.txt` that then addressed `/uploads/Uploads/a.txt`. Listed keys are now relative to the root (`a.txt`), as they are when the casing matches.
