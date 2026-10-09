---
"files-sdk": major
---

`head()`, `list()`, `listAll()`, and `search()` now return a `FileInfo` (`{ key, size, contentType, etag?, lastModified?, metadata? }`), metadata with no body, instead of a `StoredFile`.

- **No more hidden downloads:** in v2, head and list results carried `text()` / `arrayBuffer()` / `blob()` / `stream()` accessors that quietly issued a full download when called. Reading bytes is now always an explicit `download()`, which still returns a `StoredFile`. A `StoredFile` is now a `FileInfo` plus the `File`-like `name` / `type` aliases and the body accessors.
- **Renamed fields:** on head and list results, read `contentType` where you read `type`, and `key` where you read `name`.
- **Upload results:** `UploadResult` is now the same `FileInfo` shape.
- **Plugin results:** `versioning()`'s `restoreVersion()` and `softDelete()`'s `restoreTrashed()` resolve to a `FileInfo`.
- **Custom adapters:** `Adapter.head()` and `Adapter.list()` return `FileInfo`. `createStoredFile()` takes a `FileInfo` (with `contentType`, not `type`), and the `StoredFileMeta` type is removed.
- **Gateway, client, and UI:** the `files-sdk/api` wire, `files-sdk/client`, the `useFiles` bindings, and the shadcn registry components use the same shape: `contentType` instead of `type`. The client's `upload()` result is now a `FileInfo` too, and the registry components' `onSelect` / `file` / `renderPreview` values are `FileInfo`.
- **AI tools:** the AI tool results (`getFileMetadata`, `listFiles`, `downloadFile`) also carry `contentType`.
- **CLI and MCP:** `head`, `list`, `search`, and `download` output prints `contentType` instead of `type`, and no `name`.
