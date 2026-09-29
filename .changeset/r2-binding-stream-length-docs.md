---
"files-sdk": patch
---

The `files-sdk/r2` `binding` option now documents that an upload through a Workers binding needs a known length. Strings, bytes, and `Blob`s always work; a `ReadableStream` works only as a request or response body with a `Content-Length` or as the readable side of a `FixedLengthStream`, because workerd rejects a stream of unknown length.
