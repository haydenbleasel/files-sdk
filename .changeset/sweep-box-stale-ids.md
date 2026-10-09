---
"files-sdk": patch
---

The Box adapter (`files-sdk/box`) now recovers when another process deletes and re-creates a key. Box gives the new file (or folder) a new id, but each adapter instance used to keep the old one cached: `exists()` returned `false`, `head()`, `download()`, and `url()` failed with `NotFound`, `upload()` failed with `NotFound` on the dead id, and `delete()` returned without removing the live file. When a Box call answers `NotFound` after the adapter looked up ids from its cache, it now drops the cached file and folder ids for that key and retries once with fresh lookups. A miss inside a folder the adapter has just listed is still final and costs no extra calls.
