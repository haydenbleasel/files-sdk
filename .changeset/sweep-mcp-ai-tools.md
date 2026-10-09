---
"files-sdk": patch
---

The MCP server and the AI tool packs (`files-sdk/ai-sdk`, `files-sdk/openai`, `files-sdk/claude`) describe and refuse things the v3 way. The `url` / `getFileUrl` tools' `expiresIn` parameter now says it only works on adapters that can sign and fails with `Unsupported` elsewhere, instead of claiming it's ignored. The MCP `capabilities` tool lists the v3 fields (`resumable`, the `delimiter` values, `publicUrl`, `signedUrl.expiry` / `disposition`, `signedUpload`, `events`). `downloadFile`'s `maxBytes` refusals and a malformed base64 `uploadFile` body are now `Invalid` errors, so the model gets a tool error it can act on instead of a retryable `Provider` failure or a raw `DOMException`. The MCP `upload` tool infers the content type from the key when none is given, as the CLI already did, instead of storing `application/octet-stream`.
