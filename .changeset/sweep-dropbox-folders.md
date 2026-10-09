---
"files-sdk": patch
---

The Dropbox adapter (`files-sdk/dropbox`) no longer deletes or copies whole folders through its object methods. `delete()` used to call `files/delete_v2` directly, which removes a folder recursively, so `files.delete("photos")` deleted everything under `photos/`. Keys like `"/"` resolved to the adapter root, so `delete("/")` could delete the whole `rootFolderPath` folder. `delete()` now looks the key up first: a folder is a no-op, the same as a missing key. `copy()` refuses a folder source with `NotFound`. Object methods now refuse an empty key, `"/"`, or a key with a trailing `/` with `Invalid` before any Dropbox call.
