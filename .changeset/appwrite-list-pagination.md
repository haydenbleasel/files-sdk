---
"files-sdk": patch
---

Reduce round trips when listing Appwrite files by requesting 1,000 files per page by default and skipping unused total counts. Explicit page limits and cursor pagination remain supported.
