---
"files-sdk": patch
---

The Appwrite adapter (`files-sdk/appwrite`) now attaches its `resumableUpload` driver only when it has an API key, endpoint, and project ID to authenticate the raw chunk requests. A pre-built `client` keeps its key private, so with one (or with no key configured) every resumable upload of a non-empty body used to throw. `files.capabilities.resumable` now reports `false` in that case, and `upload({ control })` is refused up front with the core `Unsupported` error.
