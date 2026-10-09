---
"files-sdk": patch
---

Gateway and browser client fixes (`files-sdk/api`, `files-sdk/client`, and the framework bindings):

- Errors that aren't a `FilesError` (from `authorize`, `onUploadComplete`, or a `completions` store) now reach the client as a generic 500, and the original goes to a new `onError(error, req)` option. Storage keys in error messages are rewritten to the client's key, so the `keyPrefix` doesn't leak.
- Proxied downloads send `Cache-Control: private, no-store`, and content a browser could run (anything but images, media, and PDF) gets a sandboxing `Content-Security-Policy`.
- With a `completions` store, the proxy refuses another `PUT` once `complete` has accepted the upload (409). It also refuses tokens minted for direct-to-storage uploads.
- `complete` accepts a token for a grace period after it expires (`completeGracePeriod`, default one hour), and proxy tokens are no longer capped by the adapter's signed-upload limit.
- Keys with backslash `..` segments are refused.
- `authorize` now receives the declared file `name`, `size`, and `type` for uploads, and `filterKeys` also covers `versions`, `restore-version`, `restore-trashed`, and `complete`.
- `search` reads at most `maxSearchScan` keys (default 10,000) and reports `truncated`; the client's `search()` returns `{ truncated }` (`SearchSummary`).
- Corrected codes: an oversized upload at `complete` is `Validation` (reason `size`), a missing plugin is `Unsupported`, and a 416 carries an error body and maps to `Invalid` on the client.
- `trashed` and a scoped `purge` read only the caller's part of the trash (`softDelete().trashed({ prefix })`), `presign` signs at most `maxConcurrency` targets at once, bulk operations don't start for a disconnected client, and `auto` downloads fall back to the proxy when a redirect URL is refused.
- `UploadRejectedError` under `files-sdk/nestjs` now answers 422 instead of 500.
- `files-sdk/versioning` prunes history only after a write succeeds.
