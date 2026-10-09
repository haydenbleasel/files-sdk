---
"files-sdk": patch
---

The OneDrive adapter (`files-sdk/onedrive`), and SharePoint (`files-sdk/sharepoint`), which delegates to it, no longer deletes or copies whole folders through its object methods. A Graph `DELETE` on a folder is recursive, so `files.delete("photos")` used to delete everything under `photos/`, and `delete("/")` could delete the `rootFolderPath` folder. `delete()` now looks the item up first. A folder is a no-op, the same as a missing key. A file is deleted by its item id, so a folder that appears at the same path between the two calls is never the one removed. `copy()` refuses a folder source with `NotFound`. Object methods now refuse an empty key, `"/"`, or a key with a trailing `/` with `Invalid` before any Graph call. Calling the resumable-upload driver before its session starts now throws `Invalid` instead of a retryable `Provider` error, on both subpaths.
