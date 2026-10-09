---
"files-sdk": patch
---

The `files-sdk/api` gateway no longer sends raw error messages to the client. Anything thrown that isn't a `FilesError` or the gateway's own error (a plain `Error` from `authorize`, `onUploadComplete`, or a `completions` store, which can carry a connection string or a SQL error) now reaches the client as a generic 500 (`Provider`, "internal server error"), and the original goes to the new `onError(error, req)` router option, which defaults to `console.error`. A `FilesError`'s message still reaches the client, but a storage key it names is rewritten to the key the client sent, so provider messages (in single and bulk results, and in `complete` entries) no longer reveal the authorize `keyPrefix`.
