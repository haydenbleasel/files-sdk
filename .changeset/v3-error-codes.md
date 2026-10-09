---
"files-sdk": major
---

`FilesError` gains two codes, `Invalid` and `Unsupported`, split out of `Provider`, which now only means the backend or transport failed.

- **`Invalid`:** the call itself is wrong. That covers an empty, null-byte, or `..` key, a malformed range, ETag, or condition, contradictory options, an `expiresIn` past a hard cap, missing or bad constructor config, and a file a `validation()` rule rejects (`ValidationError` keeps its `reason`).
- **`Unsupported`:** the call is well-formed but this adapter, in this mode and with these plugins, can't do it. That covers a `range`, `metadata`, `cacheControl`, `delimiter`, or `control` the adapter has no primitive for, `url()` without a `publicBaseUrl` on FTP/SFTP/WebDAV, a `signedUploadUrl()` `maxSize` or `contentType` the provider can't bind, and the fail-closed refusals of `encryption()`, `compression()`, `dedup()`, `validation()`, and `contentType()`.
- **`permanent`:** both new codes are always `permanent` and are never retried or failed over. `Provider` is still the only retried code. `versioning()`'s `restoreVersion()` and `softDelete()`'s `restoreTrashed()` now throw `NotFound` when there's nothing to restore.
- **Code that branches on `error.code === "Provider"`** to catch bad input or unsupported options must also check `Invalid` / `Unsupported`.
- **Gateway (`files-sdk/api`):** an `Invalid` error is answered with a `422` and the wire code `Validation` (it was a `500`), and an `Unsupported` one with a `422` and the new wire code `Unsupported`. `files-sdk/client` and the `useFiles` bindings turn both back into the matching `FilesError` code, and map any wire code they don't know to `Provider`. When presigning an upload, the gateway falls back to its proxy only for an `Unsupported` or `Invalid` refusal; a backend failure or an abort now surfaces instead of being masked as a proxy target.
- **CLI:** `files` now exits `5` for a `Provider` failure, so a script can tell "the backend failed, retry" from "the command is wrong". `Invalid`, `Unsupported`, and `ReadOnly` exit `2`, like a usage error. A missing optional `@modelcontextprotocol/sdk` for `files mcp` is reported as `Unsupported`.
