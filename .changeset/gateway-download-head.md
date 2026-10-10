---
"files-sdk": patch
---

The `files-sdk/api` gateway now answers `HEAD` on the download route instead of refusing it with `422`. A proxied download returns the same headers a `GET` would (`Content-Length`, `ETag`, `Last-Modified`, the disposition) with no body, without reading the object, and a redirected download returns the same redirect.
