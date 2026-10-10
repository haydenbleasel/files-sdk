---
"files-sdk": patch
---

`files-sdk/onedrive` and `files-sdk/sharepoint` no longer reject valid `list()` cursors from page 2 onward when the drive path is percent-encoded differently in Graph's `@odata.nextLink`. This affected a `siteId` (its commas) and folder names containing characters such as `@ , ; = + $ &`. Cursors are now compared on their decoded paths, and a cursor for another folder is still refused.
