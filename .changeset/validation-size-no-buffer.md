---
"files-sdk": patch
---

`validation()` (`files-sdk/validation`) no longer reads a known-length body into memory to check `maxSize` / `minSize`. Strings, byte arrays, `Blob`s and `File`s are measured from their length and forwarded untouched, so a multi-gigabyte `File` over the limit is rejected without being buffered, and a size-only policy no longer overrides the adapter's default content type. Only unknown-length streams (and a `Blob` that reports no finite size) are still buffered to measure them.
