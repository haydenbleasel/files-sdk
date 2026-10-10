---
"files-sdk": patch
---

The `files-sdk/api` gateway no longer forwards a storage provider's error message to the client. Messages from an adapter's `NotFound`, `Unauthorized`, `Conflict`, and `Provider` errors could carry absolute filesystem paths, internal hostnames, or bucket names, so those now reach the client as a fixed message per code (`not found`, `storage provider error`, …) with the same code and status, and `Provider` and `Unauthorized` errors are passed to `onError` so the detail still reaches your logs. The SDK's own `Invalid`, `Unsupported`, and `ReadOnly` messages, and any `FilesError` thrown by your `authorize`, `files` factory, or `onUploadComplete`, are still sent as written.
