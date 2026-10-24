---
"files-sdk": patch
---

`files-sdk/appwrite` now lists 1,000 files per page by default instead of 100, and no longer asks Appwrite to compute a total count it never used, so walking a large bucket with `listAll()` takes far fewer round trips. An explicit `limit` still sets the page size, and cursor pagination is unchanged.
