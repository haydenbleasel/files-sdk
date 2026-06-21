---
"files-sdk": minor
---

Add a shadcn component registry of `useFiles`-wired UI, installable with `npx shadcn add`. Upload + display: `dropzone`, `file-list`, `file-preview`, `upload-progress`, `multipart-uploader`. Navigation + actions: `file-browser` (folder tree via `list({ delimiter })` + breadcrumbs), `file-search` (`search()` with glob/regex/substring/exact), `share-dialog` (`url()` / `signedUploadUrl()` with expiry + copy), `file-actions` (copy/move/rename/download/delete menu), `capabilities-badges` (`capabilities()` as feature badges). Plugin showcases: `version-history` (`versioning()` — list + restore snapshots) and `trash-bin` (`softDelete()` — restore + purge soft-deleted files). The components ship in the docs site rather than the package, but they're a first-class part of the SDK surface.
