---
"files-sdk": minor
---

`upload` now accepts a `control` option for **pause-able and resumable uploads**. Construct an `UploadControl`, pass it in, and pause, resume, or abort the upload — or persist `control.toJSON()` and resume it later (even in a new process or after a page reload) with `UploadControl.from(token)`.

```ts
import { Files, UploadControl } from "files-sdk";

const control = new UploadControl();
const promise = files.upload("big.iso", file, {
  control,
  multipart: { partSize: 16 * 1024 * 1024 },
  onProgress: ({ loaded, total }) => bar.set(loaded, total),
});

control.pause(); // in-flight parts settle, the promise stays pending
save(control.toJSON()); // serializable session token — persist anywhere
control.resume(); // continue

// …or, after a crash / reload, in a new process:
const result = await files.upload("big.iso", file, {
  control: UploadControl.from(load()),
});
```

**Resume across processes** (a serializable token survives a crash/reload):

- **S3 and the S3-compatible adapters** (incl. R2 over HTTP) drive S3's native multipart API directly — `CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload`, with `ListParts` to skip parts already uploaded on resume and `AbortMultipartUpload` to discard.
- **GCS**, **Firebase Storage**, and **Google Drive** resume against a stored resumable-session URI.
- **Azure Blob** stages blocks and commits them, using `getBlockList` to skip blocks already staged.
- **OneDrive** drives a Graph upload session, reading `nextExpectedRanges` to resume.
- **Dropbox** drives an upload session, tracking the byte offset in the token.
- **Vercel Blob** drives its native multipart API; completed parts are carried in the token.
- **the local filesystem** resumes from a `.fls-part` temp file on disk.
- **FTP** / **SFTP** resume by querying the remote size and appending.
- **Supabase** drives the resumable (TUS) endpoint; **Appwrite** and **Cloudinary** drive their chunked `Content-Range` uploads.

**Pause/resume in-process only** (the provider exposes no serializable session): **box** (its commit needs a whole-file digest) and **bun-s3** / **memory** (no upload-id) buffer in-process; `UploadControl.from(token)` rejects them.

Every other adapter throws a clear "not supported" `FilesError` when `control` is passed — mirroring the `range`-download gate.

`control` requires a body with a known length (`File`, `Blob`, `ArrayBuffer`, a typed array, or `string`); a `ReadableStream` can't be re-read to resume. `control.abort()` discards the provider-side session, while aborting via `signal` preserves it for a later resume.

> The Supabase (TUS), Appwrite, and Cloudinary drivers are built to each provider's documented chunked-upload protocol and covered by mocked tests; verify them against a live account before relying on them in production.
