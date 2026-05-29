# Large & resilient transfers

Four per-call options on `upload`/`download` for big objects. All are single-key options — none are available in the [bulk array form](bulk-and-transfer.md) (except `multipart`, which is a per-item field there).

## `multipart` — parallel parts

Splits a body into parts, uploads them in parallel, stitches them server-side. The robust path past the single-request limit (5 GB on S3) and for `ReadableStream` bodies of unknown length.

```ts
// Defaults: 5 MiB parts, 4 in flight.
await files.upload("backups/db.tar", stream, { multipart: true });

// Or tune it:
await files.upload("backups/db.tar", stream, {
  multipart: { partSize: 16 * 1024 * 1024, concurrency: 8 },
});
```

- **S3 + S3-compatible** (incl. R2 HTTP): runs through the optional `@aws-sdk/lib-storage` peer dep, falling back to a single `PutObject` for small bodies. **Unknown-length `ReadableStream` bodies auto-engage multipart even without the flag.**
- **OneDrive**: bodies over 250 MB (and any `multipart` request) use a chunked upload session.
- **GCS / Firebase**: switch to a resumable upload; `partSize` maps to chunk size.
- **Azure Blob**: maps `partSize`/`concurrency` to parallel block-upload tuning.
- **Dropbox**: streams `ReadableStream` bodies through its upload session chunk-by-chunk (never buffers the whole file); `partSize` rounds to a 4 MiB multiple.
- Everything else either streams natively or only takes a buffered body, so it ignores the flag.

Adapters that chunk natively round `partSize` to their own granularity (OneDrive → 320 KiB multiple, GCS/Firebase → 256 KiB); S3 enforces a 5 MiB minimum per part except the last, and caps an object at 10,000 parts (so very large objects need a big enough `partSize`). Memory footprint is up to `partSize × concurrency`. Multipart is still **one `upload` call** for retries/timeouts/cancellation — a failure retries the whole call, not a part. To retry individual parts and pause/resume, use `control` below.

## `control` — resumable uploads

Pass an `UploadControl` (exported from `files-sdk`) to drive a pause-able, resumable, **cross-process** upload.

```ts
import { Files, UploadControl } from "files-sdk";

const control = new UploadControl();
const result = files.upload("backups/db.tar", file, {
  control,
  multipart: { partSize: 16 * 1024 * 1024 },
  onProgress: ({ loaded, total }) =>
    console.log(total ? `${Math.round((loaded / total) * 100)}%` : `${loaded}`),
});

control.pause(); // stop dispatching new parts; in-flight parts settle; `result` stays pending
control.resume(); // pick up where it left off
await result;
```

It's an `AbortSignal`-style handle: a plain object you construct and drive from outside.

- **`pause()`** stops dispatching new parts (in-flight ones finish). Session preserved — the moment to `toJSON()` and persist.
- **`resume()`** continues a paused upload.
- **`abort()`** cancels **and discards the provider-side session** (cleans up the partial upload a provider might bill/retain). Terminal — the token can't be resumed. (Aborting via the `signal` option instead _keeps_ the session for later resume.)
- `control.status` (`"idle"|"uploading"|"paused"|"completed"|"aborted"|"error"`) and `control.loaded`/`control.total` track progress for a UI.

### Resume across processes

`control.toJSON()` is a small JSON-serializable token. Persist it (disk, `localStorage`, a DB row), then rebuild with `UploadControl.from(token)` and call `upload` again with the **same body** — the SDK discovers what already landed and uploads only the rest.

```ts
// First run — pause and persist.
const control = new UploadControl();
files.upload("backups/db.tar", file, { control }).catch(() => {});
// …once a session exists, control.toJSON() is populated…
localStorage.setItem("upload", JSON.stringify(control.toJSON()));

// Later — new tab / process / after a crash.
const token = JSON.parse(localStorage.getItem("upload")!);
await files.upload("backups/db.tar", file, {
  control: UploadControl.from(token),
});
```

### Requirements & support

- **Known-length body only** (`File`, `Blob`, `ArrayBuffer`, typed array, `string`). A bare `ReadableStream` is rejected — a consumed stream can't be replayed. Keep the `File` handle around (as a browser upload widget does).
- **Cross-process resume:** S3 + S3-compatible (token carries the `UploadId`; resume via `ListParts`, abort via `AbortMultipartUpload`), GCS, Firebase, Google Drive, Azure, OneDrive, Dropbox, Vercel Blob, local `fs` (`.fls-part` temp file), FTP, SFTP, Supabase (TUS), Appwrite, Cloudinary.
- **In-process only** (`toJSON()` can't resume in a new process): Box, bun-s3, memory.
- **Throws** `FilesError` "not supported" when `control` is passed: Netlify Blobs, UploadThing, PocketBase, Bunny, Convex, and the rest.
- `partSize`/`concurrency` come from `multipart` and tune the same trade-off; each part is retried individually under the call's retry policy.

> The Supabase (TUS), Appwrite, and Cloudinary resumable drivers are built to each provider's documented protocol and covered by mocked tests, but haven't been exercised against a live account — verify end-to-end before relying on them in production.

## `range` — byte-range downloads

Fetch a contiguous slice instead of the whole object — the primitive behind video seeking and resuming an interrupted download.

```ts
// Bytes 0–1023 inclusive → 1024 bytes (HTTP Range semantics, NOT slice()).
const head = await files.download("video.mp4", {
  range: { start: 0, end: 1023 },
});

// Omit `end` to read from an offset to EOF — e.g. resume a partial download.
const rest = await files.download("video.mp4", { range: { start: 1024 } });
```

Both bounds are **0-based** and `end` is **inclusive**. The returned `StoredFile.size` reflects the range length, not the full object. **Supported** by adapters with a native range primitive (S3 + S3-compatible, bun-s3, GCS, Firebase, Azure, `fs`, memory); **throws** a `FilesError` on the rest rather than silently downloading the whole object and slicing it — check `adapter.supportsRange` to branch at runtime.

## `onProgress` — upload progress

```ts
await files.upload("big.iso", file, {
  onProgress: ({ loaded, total }) =>
    bar.set(total ? loaded / total : undefined),
});
```

`total` is present for buffered bodies, omitted for unknown-length streams. Granularity:

- A `ReadableStream` body reports byte-by-byte as the adapter consumes it.
- A buffered body reports `{ loaded: 0, total }` then `{ loaded: total, total }` — _unless_ the adapter reports true progress itself.
- **S3 + S3-compatible** report true byte-level progress for every body type, including multipart, via `@aws-sdk/lib-storage` (the optional peer dep must be installed to use `onProgress` there).

Only fires while in flight and on success; a failed upload emits no final event, and on retry progress restarts. The bulk `upload([...])` form's `onProgress` additionally carries the item `key`.
