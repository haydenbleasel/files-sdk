---
"files-sdk": patch
---

A proxied download through `files-sdk/api` no longer answers `500` for an object whose stored content type can't be sent as a header (one written outside the gateway with a character past U+00FF). The gateway serves it as `application/octet-stream` instead.
