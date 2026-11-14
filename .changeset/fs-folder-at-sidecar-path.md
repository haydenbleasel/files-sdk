---
"files-sdk": patch
---

The filesystem adapter (`files-sdk/fs`) no longer mistakes a folder for a sidecar. A key such as `report.meta.json/page.txt` creates a folder at the path where the key `report` keeps its sidecar: `list()` then failed for the whole root, `head()` and `download()` of `report` threw `Conflict`, and `upload("report")` rejected with the new body already written. The folder now reads as "no sidecar", and an upload, copy, or resumable upload to such a key is refused with `Conflict` before the body is replaced.
