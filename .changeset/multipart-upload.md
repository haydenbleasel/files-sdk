---
"files-sdk": minor
---

`upload` now accepts a `multipart` option for uploading large bodies in parallel parts.

```ts
await files.upload("backups/db.tar", stream, {
  multipart: true, // or { partSize, concurrency }
});
```

- **S3 and the S3-compatible adapters** (incl. R2 over HTTP) run multipart through `@aws-sdk/lib-storage`, falling back to a single `PutObject` for small bodies. Unknown-length `ReadableStream` bodies now use multipart automatically, even without the flag.
- **OneDrive** uploads above its 250 MB simple-upload limit (and any `multipart` request) now go through a chunked upload session instead of throwing — large files just work.
- **GCS** and **Firebase Storage** switch to a resumable upload when `multipart` is set; `partSize` maps to the chunk size.
- **Azure Blob** maps `partSize`/`concurrency` to its parallel block-upload tuning.
- **Dropbox** now streams `ReadableStream` bodies through its upload session chunk-by-chunk instead of buffering the whole file in memory; `partSize` tunes the chunk size (rounded to a 4 MiB multiple).
- The array form of `upload` accepts a per-item `multipart` toggle/tuning too.

Other adapters already stream natively or only accept a fully-buffered body, so they ignore the option.
