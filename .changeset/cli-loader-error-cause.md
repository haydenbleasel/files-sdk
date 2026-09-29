---
"files-sdk": patch
---

`loadFiles` from `files-sdk/loader` (and the `files` CLI) now keeps the adapter's original construction error as the `cause` of the `FilesError` it throws when it appends a provider's configuration hint. Previously the hinted error dropped it.
