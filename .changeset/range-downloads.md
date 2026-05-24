---
"files-sdk": minor
---

`download` now accepts a `range` option for fetching a contiguous byte slice of an object — the primitive behind video seeking and resumable downloads.

```ts
// Bytes 0–1023 (end is inclusive, matching the HTTP Range header) → 1024 bytes.
const head = await files.download("video.mp4", {
  range: { start: 0, end: 1023 },
});

// Omit end to read from an offset to EOF — e.g. resume an interrupted download.
const rest = await files.download("video.mp4", { range: { start: 1024 } });
```

Both bounds are 0-based and `end` is inclusive, mirroring the `bytes=start-end` request the supporting adapters issue. The returned `StoredFile` carries just the requested bytes and reports the range length as its `size`. `range` works with `as: "stream"` so you never buffer the whole slice.

- **S3 and every S3-compatible adapter** (R2 over HTTP, MinIO, DigitalOcean Spaces, Wasabi, Tigris, Backblaze B2, Storj, Hetzner, Akamai, and the rest of the `s3()` family) issue a ranged `GetObject`.
- **Bun S3** slices via `S3File.slice`, **GCS** and **Firebase Storage** via `createReadStream`/`download` byte offsets, **Azure Blob** via its offset/count download, and the **R2 Workers binding** via its native `range` option.
- The local **`fs`** adapter reads only the requested bytes off disk, and the in-memory adapter slices its buffer.
- The fetch-based adapters — **UploadThing, Box, Vercel Blob (public), Cloudinary, PocketBase, Dropbox, OneDrive, SharePoint, and Google Drive** — send an HTTP `Range` header and verify the host replied `206 Partial Content`, throwing if it ignored the range and returned the whole object (so the bandwidth saving is never silently lost).

Adapters whose provider has no range primitive (Supabase, Appwrite, Netlify Blobs, Bunny Storage, Convex, and Vercel Blob private blobs) throw a `FilesError` rather than downloading the whole object and slicing it client-side. Custom adapters opt in by setting `supportsRange: true` and honoring `DownloadOptions.range`; the `Files` wrapper validates the range and gates unsupported adapters before any provider call.
