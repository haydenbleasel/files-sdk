---
"files-sdk": minor
---

`upload` now accepts an `onProgress` callback for reporting realtime progress — e.g. to drive a progress bar.

```ts
await files.upload("big.zip", stream, {
  onProgress: ({ loaded, total }) =>
    console.log(
      total ? `${Math.round((loaded / total) * 100)}%` : `${loaded} bytes`
    ),
});
```

Granularity depends on the body and the adapter:

- A `ReadableStream` body is reported byte-by-byte on every adapter, as the bytes are consumed (`total` is omitted, since the length is unknown).
- A buffered body (`File`, `Blob`, `ArrayBuffer`, `Uint8Array`, `string`) reports `{ loaded: 0, total }` then `{ loaded: total, total }` by default.
- Adapters with a native upload-progress hook report true byte-level progress for every body type (buffered included): S3 and the S3-compatible adapters, R2 (HTTP), Azure Blob, Google Cloud Storage, Firebase Storage, Vercel Blob, and FTP. The S3 family uses `@aws-sdk/lib-storage` (a new optional peer dependency loaded only when `onProgress` is used) and also gains multipart for large files; GCS and Firebase Storage switch to a resumable upload when `onProgress` is set.

The array form of `upload` accepts `onProgress` too; each report carries the item's `key`. Custom adapters can opt into reporting progress themselves by setting `reportsUploadProgress: true` and calling `opts.onProgress`.
