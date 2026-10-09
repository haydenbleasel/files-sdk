---
"files-sdk": major
---

The array (bulk) forms of `upload`, `download`, `head`, and `delete` now resolve to one shape, `BulkResult<T>` = `{ results: T[]; errors?: BulkError[] }`, instead of four differently named arrays.

- **Field renames:** read `results` where you read `uploaded`, `downloaded`, `files`, or `deleted`. `exists([…])` keeps its `{ existing, missing, errors? }` split.
- **Type changes:** `UploadManyResult`, `DownloadManyResult`, `HeadManyResult`, and `DeleteManyResult` are now aliases of `BulkResult`. `DeleteManyOptions` is an alias of `BulkOptions`, and `DeleteManyError` is removed in favour of `BulkError` (the same `{ key, error }` shape).
- **`stopOnError` on a bulk `delete`:** it now always deletes one key at a time and skips the adapter's native batch, because a batch request can't stop partway. So it returns the same result with or without plugins installed, where before the native path and the plugin path could disagree.
- **Custom adapters:** an `Adapter.deleteMany` returns `{ results, errors? }`.
- **Gateway, client, CLI, and MCP:** the `files-sdk/api` wire, `files-sdk/client`, the `useFiles` bindings, and the CLI and MCP bulk output use the same shape.
