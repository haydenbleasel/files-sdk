# files-sdk

## 1.8.0

### Minor Changes

- 87607ec: Add a `compression()` plugin at `files-sdk/compression` for transparent, at-rest compression. Bodies are gzipped (or deflate / deflate-raw) on upload with the algorithm and original size recorded in metadata, and decompressed on download (bulk calls too); incompressible data is stored verbatim so storage never grows. Uses only the Compression Streams API — no native dependencies — and works on any adapter that supports metadata.
- d2fa5e0: Add a `contentType()` plugin at `files-sdk/content-type` that decides an upload's `Content-Type` from its bytes instead of the client's claim. It magic-byte-sniffs the body on `upload` and either corrects the stored type to match (the default) or rejects a mismatch, so a `.png` whose bytes are really HTML/SVG can't be stored under an image type and served inline. Recognizes the common images, PDF, and — via a leading text scan — HTML, SVG, and XML. It writes no metadata and only reads the first 512 bytes, so known-length bodies are peeked with no copy and streams stay streaming; `signedUploadUrl()` fails closed (a direct client upload bypasses the sniff). Also exports `detectContentType()`. No native dependencies; works on any adapter.
- 5ad680e: Add a `dedup()` plugin at `files-sdk/dedup` for content-addressed de-duplication. On `upload` the body is hashed (SHA-256) and its bytes are stored only once at a content-addressed blob under a store prefix (`.dedup/` by default); the logical key holds a tiny pointer to it, so re-uploading content already in the store skips the byte upload, and `copy` / `move` of a de-duplicated file is near-free and shares the blob. Reads are transparent — `download` follows the pointer (ranges included, since blobs are stored verbatim), and `head` / `list` report the logical size with internal fields stripped — for bulk calls too. Uses only the Web Crypto API — no native dependencies — and works on any adapter that supports metadata. It buffers the body to hash it (so it doesn't suit unknown-length streams or resumable uploads), `url()` / `signedUploadUrl()` fail closed, and orphaned blobs aren't garbage-collected. Place it before `compression()` / `encryption()` in the array — encrypted bytes don't de-dup.
- feaf806: Add an `encryption()` plugin at `files-sdk/encryption` for provider-agnostic, at-rest envelope encryption. A per-object data key encrypts the body with AES-256-GCM and your master key wraps it into the object's metadata; downloads decrypt transparently (bulk calls too). Uses only the Web Crypto API — no native dependencies — and works on any adapter that supports metadata. Also exports `generateEncryptionKey()`.
- 4d40229: Add a `files.search(pattern, options?)` method that finds objects whose key matches a pattern. By default `pattern` is a standard glob (powered by picomatch: `*` within a path segment, `**` globstar across segments, `?`, `[a-z]` classes, `{a,b}` braces, `!` negation; a glob with no wildcards is an exact match); set `match` to `"regex"`, `"substring"`, or `"exact"`, or pass a `RegExp` directly, to change that. It returns a streaming async iterable of `StoredFile` built on `listAll`, so it walks every page lazily (stays memory-bounded, `break` or `maxResults` to stop early) and works on every adapter with no per-provider capability. A glob's literal prefix is pushed down to the underlying `list` automatically (`uploads/2024/*.pdf` scopes the walk to the `uploads/2024` prefix); for a regex/substring/case-insensitive search, pass `prefix` to bound the walk. The CLI gains a `files search <pattern>` command (`--match`/`--regex`/`--prefix`/`--limit`/`--max-results`/`--case-insensitive`) and the MCP server a `search` tool.
- 3a42a18: Add an opt-in plugin system to `Files`. Plugins wrap every operation in an ordered onion — they can transform, veto, or observe (the interceptable superset of `hooks`) — and can contribute new namespaced surface.

  ```ts
  const files = createFiles({
    adapter: s3({ bucket: "uploads" }),
    plugins: [
      {
        name: "uppercase",
        wrap: handlers({
          upload: (op, next) =>
            next({ ...op, body: (op.body as string).toUpperCase() }),
        }),
      },
    ],
  });
  ```

  Each plugin offers two optional capabilities: `wrap` (intercept any operation via the `next` onion) and `extend` (add methods like `files.usage()`). Ships with the `handlers()` helper for authoring per-verb `wrap`s with automatic passthrough, and the `createFiles()` factory that surfaces `extend` methods on the instance type. Plugins run inside the `onAction`/`onError` hooks but outside retry and key prefixing, and intercept both single and bulk operations.

- 79e0104: Add a `tracing()` plugin at `files-sdk/tracing` for OpenTelemetry spans around every operation. Each call opens one span named `files.<verb>` carrying the caller-facing key (or `from` / `to` for `copy` / `move`), a `files.bulk` flag for batch items, and a cheap result attribute on success (`files.size`, `files.exists`, `files.count`); a throw is recorded with `recordException` and an `ERROR` status, then re-thrown untouched. Spans are opened with `startActiveSpan`, so each op span nests under your active request span and the sub-operations inner plugins issue nest beneath it in turn. `@opentelemetry/api` is an **optional peer dependency**: the tracer defaults to the global `trace.getTracer("files-sdk")` (a no-op until you register an OpenTelemetry SDK), or pass your own to scope the instrumentation name/version. Tune span names with `spanPrefix` and attach or redact attributes with `attributes(op)` (return `{ "files.key": undefined }` to keep sensitive keys out of traces). It's body-transparent (sizes come from declared metadata, never the bytes, so streaming / ranges / `url()` keep working), counts one span per logical operation rather than per retry attempt, and opens a span per item of a bulk call. Place it first (outermost) to span the caller-facing operation with inner-plugin work nested beneath, or last to time only the provider call.
- 60f3b63: Add a `usage()` plugin at `files-sdk/usage` for metering storage, bandwidth, and operation counts. It tallies every operation on a `Files` instance and surfaces the running totals via `files.usage()`: each call counts as one operation (with a per-verb `operationsByKind` breakdown), `upload` adds its result size to `bytesUp`, and `download` / `head` wrap the returned body so the bytes you actually read add to `bytesDown` — metered lazily, chunk-by-chunk, so an unread body costs nothing and a fire-and-forget hook couldn't do it. Pass `{ group }` to bucket usage per tenant or prefix and read it back with `usageByGroup()`; `resetUsage()` starts a fresh window. It's body-transparent (no buffering, no metadata, no native deps, so streaming / ranges / `url()` keep working), counts logical operations rather than retry attempts, and counts each item of a bulk call. Place it first (outermost) to meter logical bytes and caller-facing operations, or last to meter bytes-on-the-wire to the provider. Construct with `createFiles` so `files.usage()` shows up on the type.
- 8c68c34: Add a `validation()` plugin at `files-sdk/validation` — a fail-closed guard that vets writes before any bytes reach the adapter. Enforce a max/min size, an allowed-MIME-type list (exact or `type/*`), and a key-naming rule (a `RegExp` or predicate); the key rule also guards the destination of `copy`/`move`. It transforms nothing and stores no metadata, so reads, `url()`, `copy`, and `move` pass straight through, while `signedUploadUrl()` fails closed when a size or type rule is set (a presigned upload bypasses the plugin). No native dependencies; works on any adapter.
- 3cecd4c: Add a `versioning()` plugin at `files-sdk/versioning` that snapshots an object's prior bytes before any overwrite or delete and adds `files.versions(key)` / `files.restore(key, versionId?)` to roll a key back. Snapshots are server-side copies under a configurable prefix (`.versions/` by default), so it's body-transparent — streaming, range downloads, `url()`, and `signedUploadUrl()` keep working, and it composes with `compression()` / `encryption()` by snapshotting whatever they stored. Optional `limit` caps the versions kept per key; version objects are hidden from `list()`. It's the first plugin to use `extend`, so use `createFiles` to surface the new methods on the type. No native dependencies; works on any adapter.

### Patch Changes

- 5ad680e: Fix plugin cross-kind re-routing inside bulk operations. A plugin whose `wrap` calls `next()` with a different verb than the one it's intercepting — e.g. `dedup()`'s `exists` probe, or `versioning()`'s snapshot `head` + `copy` — misrouted when it ran inside `upload([...])` / `download([...])` / `head([...])` / `exists([...])` / `delete([...])`, because each bulk item was dispatched with a base locked to that one verb. The bulk bases now delegate any re-routed, cross-kind sub-op to the single-operation path, so it behaves identically in a bulk call as in a single one; the item's own verb keeps its retry-free, hook-quiet semantics.
- 0f3771e: Switch the build from tsup to Bun's bundler (for JavaScript) plus tsgo (for type declarations), orchestrated by `scripts/build.ts`. tsup is no longer maintained and its declaration emit needed an enlarged Node heap; the replacement builds the whole package — every adapter, plugin, and the CLI — in well under a second with no heap flag. The published ESM output and `exports` map are unchanged, so imports resolve identically. The only packaging difference is that type declarations are now emitted per source file rather than rolled up into bundled `.d.ts` files; type resolution for consumers is equivalent.

## 1.7.0

### Minor Changes

- 3c8abf3: Add `sync()` — an incremental, optionally-pruning mirror between two providers. It skips objects already identical at the destination (compare by size + etag, size, or a custom predicate), can prune destination keys the source no longer has (mirror mode), and supports `dryRun` to preview the reconciliation plan. Surfaced at parity as the CLI `sync` command and a write-gated MCP `sync` tool.
- d998ef6: Add directory-style listing to `list`: a new `delimiter` option collapses keys into S3-style common prefixes ("folders"), returned in `ListResult.prefixes`. Supported on every adapter with a folder or prefix model — the object stores (S3 family, R2, GCS, Firebase Storage, Azure) and `fs`/memory/FTP/SFTP/Google Drive/Cloudinary accept any delimiter; the folder-based providers (Vercel Blob, Netlify Blobs, Supabase, Dropbox, Box, OneDrive, SharePoint) accept `"/"`. Adapters with no folder concept (UploadThing, Appwrite, PocketBase, Convex, Bun's S3) advertise `supportsDelimiter: false` and throw rather than silently returning a flat list.

  The CLI and MCP server expose this too: `files list --delimiter /` returns the direct files in `items` and the subfolders in a `prefixes` array, and the MCP `list` tool gains the same `delimiter` argument. Both throw on adapters with no folder concept and reject being combined with `--all` / `all` (which walks the whole tree).

- 0345169: Add read-only `Files` instances.

  Pass `readonly: true` to the constructor, or derive a locked view from an existing client with `files.readonly()`, when a caller should be able to read storage but never mutate it:

  ```ts
  const files = new Files({
    adapter: s3({ bucket: "uploads" }),
    readonly: true,
  });

  const readOnly = files.readonly(); // reuses the same adapter, prefix, timeout, retries, and hooks
  ```

  Reads stay available (`download`, `head`, `exists`, `list`, `listAll`, `url`). Every write surface — `upload`, `delete`, `copy`, `move`, `signedUploadUrl`, and the equivalent `file(key)` helpers (`upload`, `delete`, `copyTo`, `copyFrom`, `moveTo`, `moveFrom`, `signedUploadUrl`) — now fails immediately, before the adapter is touched, with a new normalized `FilesError { code: "ReadOnly" }`. The failure is deterministic and is not retried; `onError` and the final `onAction({ status: "error" })` hooks still fire.

  The `raw` escape hatch is not governed by the guard — code that writes through `files.raw` bypasses it by design.

- dbf6ded: `upload` now accepts a `control` option for **pause-able and resumable uploads**. Construct an `UploadControl`, pass it in, and pause, resume, or abort the upload — or persist `control.toJSON()` and resume it later (even in a new process or after a page reload) with `UploadControl.from(token)`.

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

### Patch Changes

- 1ff2550: Azure gains a native `deleteMany` backed by the Blob Batch API (256 keys per batch, idempotent on already-missing blobs); `stopOnError` falls back to sequential deletes. Previously it fanned out to single deletes.
- e1d09a6: Validate Microsoft Graph pagination cursors against the adapter root before following them for OneDrive and SharePoint list calls.
- e1d09a6: Cap AI tool download `maxBytes` overrides at 10 MiB and reject oversized values in both schema validation and direct executor calls.
- e1d09a6: Bound CLI MCP downloads by checking object metadata and requested byte ranges before transferring response bodies.
- e1d09a6: Reject `.` and `..` segments in `Files` prefixes and prefixed keys before resolving local filesystem paths, so prefixed fs adapters cannot escape their configured root.
- 1ff2550: FTP & SFTP `move()` now uses a native rename (`RNFR`/`RNTO` and the SFTP `RENAME` op) instead of a copy + delete body round-trip. The destination's parent directory is created first where needed.
- 1ff2550: FTP & SFTP now support ranged downloads (`download(key, { range })`): SFTP uses native read-stream `start`/`end` offsets; FTP begins the transfer at the `REST` start offset and trims a bounded `end` client-side. Both adapters now advertise `supportsRange`.
- e1d09a6: Start the MCP server in read-only mode by default and require `--allow-writes` before registering mutation tools.
- 1ff2550: Gate unsupported `metadata` / `cacheControl` centrally in the `Files` wrapper via new `Adapter.supportsMetadata` / `Adapter.supportsCacheControl` flags — exactly like `supportsRange`. Every adapter is flagged accurately and the per-adapter inline throws (Convex, FTP, SFTP, Dropbox, Box, OneDrive, Cloudinary, Appwrite, PocketBase, Bunny Storage, Bun's S3) are removed in favor of the one gate. **Behavior change:** Vercel Blob (`metadata`), UploadThing (`metadata`/`cacheControl`), and SharePoint (`metadata`/`cacheControl`) previously dropped these options silently and now throw a `FilesError`, matching every other adapter.
- 1ff2550: R2 (HTTP) now advertises `supportsRange`, so ranged downloads work in HTTP mode — it delegates to `s3()`, which honors the `Range` request. The R2 Workers binding already supported them.
- e1d09a6: Reject `responseContentDisposition` for fs, FTP, and SFTP public URLs because those static URLs cannot bind the override into a signature.
- e1d09a6: Reject Azure signed upload `contentType` overrides because Azure SAS URLs do not bind the request Content-Type into the signature.
- e1d09a6: Reject Google Drive, OneDrive, and SharePoint signed upload `maxSize` and `minSize` options because their upload sessions cannot enforce a server-side content-length policy.
- e1d09a6: Reject relative path segments in OneDrive and SharePoint delegated paths before building Microsoft Graph item URLs, keeping `rootFolderPath` scoped to its configured folder.
- e1d09a6: Scope Google Drive virtual-key file ID resolution to `rootFolderId` by including the configured root folder parent in Drive lookup queries.

## 1.6.0

### Minor Changes

- 12d6218: Bring the CLI (and MCP server) to full parity with the SDK surface.

  Every `Files` capability is now reachable from the `files` binary:

  - **Global `--key-prefix`** scopes every operation under a base path (the instance prefix from `new Files({ prefix })`, distinct from the one-off `list --prefix` filter). **Global `--timeout` / `--retries`** set the per-attempt timeout and retry count for all commands.
  - **`download --range start-end`** downloads a byte range (0-based, inclusive), e.g. `0-1023` or `1024-`.
  - **`upload --multipart`** (with `--part-size` / `--multipart-concurrency`) uploads large objects in parallel parts.
  - **`head` / `exists` / `delete`** accept `--concurrency` and `--stop-on-error` to tune the bulk fan-out for many keys.
  - **`list --all`** walks every page (following the cursor) and returns all items in one result.
  - **`upload --dir <localDir>`** uploads a whole local tree (keyed by relative path, content type inferred per file), and **`download <keys...> --out-dir <dir>`** downloads many keys into a directory — both built on the SDK's bulk array forms.
  - **`transfer`** copies every object from the configured (source) provider to another provider given as a JSON config (`--to`), streaming each body across backends. `--prefix` filters the walk and `--no-overwrite` skips keys already present at the destination.

  The MCP server mirrors all of the above: the `upload` tool takes `multipart`, `download` takes a byte `range`, the `head` / `exists` / `delete` tools take `concurrency` / `stopOnError`, `list` takes `all`, and a new `transfer` tool copies objects across providers. The global `--key-prefix` / `--timeout` / `--retries` bind to the server's `Files` instance at startup.

- 0bb7ca3: Add `transfer` for cross-provider migration.

  `transfer(source, dest, options?)` streams every object from one `Files` instance to another — the one operation the unified surface uniquely enables, since `copy`/`move` live inside a single adapter. It's built entirely on public primitives (the source's `listAll` + streaming `download`, the destination's `exists` + `upload`), so no adapter implements anything new.

  ```ts
  import { Files, transfer } from "files-sdk";
  import { s3 } from "files-sdk/s3";
  import { r2 } from "files-sdk/r2";

  const from = new Files({ adapter: s3({ bucket: "old" }) });
  const to = new Files({
    adapter: r2({ bucket: "new", accountId, accessKeyId, secretAccessKey }),
  });

  const { transferred, skipped, errors } = await transfer(from, to, {
    prefix: "uploads/",
    onProgress: ({ done, key }) => console.log(done, key),
  });
  ```

  Both sides are full `Files` instances, so each leg honors its own `prefix`, retries, timeouts, and hooks. Each object is streamed download-to-upload — the destination never buffers a whole large file. Body, content type, and user metadata travel; `etag`/`lastModified` are destination-assigned and `Cache-Control` is not carried.

  Like the bulk array methods, `transfer` doesn't throw on partial failure: results come back as `{ transferred, skipped?, errors? }` in walk order. Options cover `prefix`, `transformKey`, `overwrite` (skip keys already present), `concurrency` (default 8), `limit` (walk page size), `stopOnError` (sequential, bail at first failure), `signal`, and `onProgress`.

- 5d24bc8: Add `hooks` to `new Files(...)` so applications can observe SDK activity with `onAction`, `onError`, and `onRetry`.

  Each hook is fire-and-forget (called, not awaited) and receives a small, caller-facing event — the operation `type`, the public `key` / `keys` (or `from` / `to` for `copy`), timing, and the final result or error. It mirrors the lightweight `onProgress` callback style.

- c50a55a: Add an in-memory adapter at `files-sdk/memory`. It implements the full `Adapter` contract backed by a `Map`, so you can test code that uses `Files` without touching disk or real storage — the same swap-in-via-env story as the other adapters, but with nothing to clean up.

  ```ts
  import { Files } from "files-sdk";
  import { memory } from "files-sdk/memory";

  const files = new Files({ adapter: memory() });
  await files.upload("hello.txt", "hi");
  (await files.download("hello.txt")).text(); // "hi"
  ```

  Zero dependencies and isomorphic (no `node:fs`/`node:crypto`), so it runs unchanged in Node, Bun, Deno, the browser, and edge runtimes. Pass `initial` to pre-populate fixtures, and reach into `adapter.raw` (the backing `Map`) to inspect or reset the store between tests:

  ```ts
  const adapter = memory({ initial: { "users/1.json": '{"id":1}' } });
  adapter.raw.clear();
  ```

  `url()` returns an opaque, non-fetchable `memory://${key}` and `signedUploadUrl()` a `memory://` placeholder — there's no server backing the store. It's a test/reference adapter, not for production.

- 67349f4: Add `move` and `listAll`.

  `files.move(from, to, options?)` renames a key. It uses the adapter's native rename where one exists (the `fs` adapter renames in place atomically; Cloudinary uses its server-side `rename`, keeping the same `asset_id` with no re-upload) and otherwise falls back to `copy` + `delete` — the same two-step every object store takes, since none offer an atomic move. Moving a key onto itself is a no-op, so the fallback can't copy-then-delete a file out of existence. `move` throws on Convex, where `copy` does (immutable storage ids, no rename).

  ```ts
  await files.move("uploads/tmp-abc.png", "avatars/user-123.png");
  ```

  `FileHandle` gains the matching `moveTo` / `moveFrom`, and `move` fires the lifecycle hooks (`onAction` / `onError` / `onRetry`) with a new `"move"` action type.

  `files.listAll(options?)` walks every page as an async iterable, following the cursor for you:

  ```ts
  for await (const file of files.listAll({ prefix: "avatars/" })) {
    console.log(file.key, file.size);
  }
  ```

  `prefix` scopes the walk and `limit` sets the per-page size; each page is a real `list` call, so retries, timeouts, and prefix scoping all apply.

  Custom adapters can implement an optional `move(from, to, opts?)` to provide a native rename; omitting it keeps the copy + delete fallback.

  The CLI gains a `move <from> <to>` command and the MCP server exposes a matching `move` tool.

- a96874f: `upload` now accepts a `multipart` option for uploading large bodies in parallel parts.

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

- 64cf324: `download` now accepts a `range` option for fetching a contiguous byte slice of an object — the primitive behind video seeking and resumable downloads.

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

- 841175a: `upload` now accepts an `onProgress` callback for reporting realtime progress — e.g. to drive a progress bar.

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

### Patch Changes

- 52daa66: Update bundled and peer dependencies.

  The CLI's `commander` runtime dependency moves to v14. Several optional provider-SDK peer floors are raised to the majors now built and tested against:

  - `@anthropic-ai/claude-agent-sdk` → `^0.3.0` (claude adapter)
  - `@googleapis/drive` → `^20.0.0` (google-drive adapter)
  - `google-auth-library` → `^10.0.0` (gcs / google-drive auth)
  - `node-appwrite` → `^25.0.0` (appwrite adapter)
  - `pocketbase` → `^0.27.0` (pocketbase adapter)

  No public API or behaviour changes. If you use one of the adapters above, upgrade its peer to the new major.

- 26989e0: The published package now ships its documentation. The full docs are bundled at `node_modules/files-sdk/docs` (per-adapter pages under `docs/adapters/`, AI tools under `docs/ai/`, plus `overview`, `api`, `cli`, `providers`, and `troubleshooting`), so tools and agents can read version-matched reference material offline instead of relying on the hosted site.
- 7027836: In-memory adapter (`files-sdk/memory`): give `metadata` the same value semantics the bytes already have. The adapter cloned an entry's bytes on the way in but stored and returned the `metadata` object by reference, so three aliases leaked: mutating the object passed to `upload()` (or an `initial` seed) after the call reached into the store, mutating a `head()`/`download()` result's `metadata` reached back into the store, and `copy()` left the source and destination sharing one mutable metadata object — mutating one silently changed the other. Metadata is now shallow-cloned on write and on read, so each stored entry owns its own copy and every read hands back a fresh one, matching how a real backend round-trips metadata. Bytes behavior is unchanged.
- 293ba1d: `onProgress` is now truly fire-and-forget: a throwing progress reporter can no longer fail or retry the upload it observes. Previously, a buffered upload's final progress report ran inside the retryable attempt, so a throw was caught by the retry layer, mislabelled a provider error, and re-uploaded the body up to `retries` times before rejecting; on the streaming path a throw errored the underlying stream and failed the upload. All three wrapper-driven `onProgress` calls now route through the same swallow-and-ignore guard the `hooks` callbacks use, matching the contract already documented on `FilesHooks` ("a hook that throws can never fail the operation it observes"). Self-reporting adapters (`reportsUploadProgress`) are unaffected — they own their own reporting.
- 1b978b9: Fix `signedUploadUrl({ maxSize })` failing with `501 Not Implemented` on Cloudflare R2.

  The R2 adapter inherited the S3 adapter's behaviour of routing `maxSize` through a presigned `POST` policy (`content-length-range`). Cloudflare R2 does not implement the S3 `POST Object` API, so those uploads failed at upload time with `501 Not Implemented`.

  R2 now throws a clear `Provider` error when `maxSize` is passed (matching how the Azure and Supabase adapters handle the same limitation), instead of handing back a POST form R2 can't serve. Omit `maxSize` to get a presigned `PUT` URL, and enforce upload caps at your application gateway. Fixes #49.

## 1.5.0

### Minor Changes

- c6b4df1: `upload`, `download`, `head`, and `exists` now accept an array for bulk operations, mirroring `delete`. Pass the usual single argument for the original behavior (resolves to one result, throws on failure); pass an array to operate on many in one call and get back a structured result instead of throwing on partial failure — so you can see exactly which keys succeeded and which failed:

  ```ts
  const up = await files.upload(
    [
      { key: "avatars/a.png", body: a, contentType: "image/png" },
      { key: "avatars/b.png", body: b },
    ],
    { concurrency: 8, stopOnError: false }
  );
  up.uploaded; // UploadResult[] — successes, in the order supplied
  up.errors; // undefined when every item succeeded

  const down = await files.download(["a.png", "b.png"]); // { downloaded, errors? }
  const meta = await files.head(["a.png", "b.png"]); // { files, errors? }
  const there = await files.exists(["a.png", "b.png"]); // { existing, missing, errors? }
  ```

  `upload`'s array items are flat — each carries its own `key`, `body`, and optional `contentType` / `cacheControl` / `metadata`. No provider exposes a native batch primitive for these operations, so the SDK always fans out to per-key calls with bounded `concurrency` (default 8); `stopOnError: false` (default) attempts every item and collects per-key failures in `errors`, while `stopOnError: true` stops at the first failure. All array forms honor the client's `prefix` and report the keys the caller passed, not the internal prefixed paths. Invalid keys are reported in `errors` rather than thrown. `exists` splits results into `existing` / `missing` and only routes hard errors (auth, transport) to `errors`. The `files` CLI's `head` and `exists` commands and the MCP `head` / `exists` tools accept multiple keys too.

- ed72daf: Add a Convex storage adapter (`files-sdk/convex`). Convex file storage is only reachable from inside a Convex function, so the adapter wraps the function context — `convex({ ctx })`, constructed per request inside an action, mutation, or query — and maps the unified `Adapter` surface onto `ctx.storage` / `ctx.db.system`. Because Convex assigns the storage id (`Id<"_storage">`) and exposes no writable metadata, the storage id is the key: `upload()` returns the assigned id, and `download`/`head`/`delete`/`url` take it back. Available operations follow Convex's context rules — `upload`/`download` need an action, `list` needs a query/mutation — and the adapter throws a descriptive error when a primitive is unavailable. `copy`, custom `metadata`, and `cacheControl` are unsupported; `url()` returns a permanent serving URL; `signedUploadUrl()` returns Convex's raw-body POST upload URL. `convex` is an optional peer dependency.
- bad4a80: `delete()` now accepts an array of keys for bulk deletion. Pass a string to remove one object (resolves to `void`, throws on failure as before); pass an array to remove many in one call and get back a structured `{ deleted, errors? }` result instead of throwing on partial failure — so you can see exactly which keys failed:

  ```ts
  const result = await files.delete(
    ["avatars/a.png", "avatars/b.png", "avatars/c.png"],
    { concurrency: 8, stopOnError: false }
  );

  result.deleted; // string[] — keys removed, in the order supplied
  result.errors; // undefined when every key succeeded
  ```

  Adapters with a native bulk primitive use it — S3 sends `DeleteObjects` (chunked into batches of 1000, the provider limit), Supabase uses `remove(keys)`, and UploadThing uses `deleteFiles(keys)` — while every other adapter fans out to single deletes with bounded `concurrency` (default 8). `stopOnError: false` (default) attempts every key and collects per-key failures in `errors`; `stopOnError: true` stops at the first failure. Invalid keys are reported in `errors` rather than thrown, and the array form honors the client's `prefix` and is no-op friendly on providers that treat a missing key as success. The `files` CLI's `delete` command and the MCP `delete` tool accept multiple keys too.

- 9e9fa13: Add FTP and SFTP adapters (`files-sdk/ftp`, `files-sdk/sftp`) for on-prem and legacy file servers. Both expose the standard unified surface, so they're interchangeable with the cloud adapters:

  ```ts
  import { Files } from "files-sdk";
  import { sftp } from "files-sdk/sftp";

  const files = new Files({
    adapter: sftp({
      host: "files.example.com",
      username: process.env.SFTP_USERNAME!,
      privateKey: process.env.SFTP_PRIVATE_KEY!,
      root: "/uploads",
    }),
  });

  await files.upload("reports/q1.csv", csv, { contentType: "text/csv" });
  ```

  FTP uses [`basic-ftp`](https://www.npmjs.com/package/basic-ftp) (with FTPS via `secure: true`); SFTP uses [`ssh2-sftp-client`](https://www.npmjs.com/package/ssh2-sftp-client). Both are optional peer dependencies. These adapters are **Node-only** (raw sockets — no edge/browser/Workers support) and connect per operation by default; pass a pre-connected `client` to reuse one connection for batch work. Keys resolve under a configurable `root` with a `..` traversal guard, `list` walks the tree recursively with cursor pagination, and `deleteMany` reuses a single connection. These protocols store no MIME type (inferred from the file extension), no arbitrary `metadata`/`cacheControl` (both throw), and serve no HTTP — `url()` requires a `publicBaseUrl` pointing at an HTTP server fronting the same tree, and `signedUploadUrl()` throws. `copy` round-trips the bytes through the client since neither protocol has a portable server-side copy.

- 1eb1dfc: Add a `files-sdk/providers` export: a zero-dependency catalog of every storage provider and the environment variables each one reads. `PROVIDERS` maps each slug to its display name, description, optional peer dependencies, and a structured env spec — `required` vars, mutually exclusive `credentialModes` (so Azure's connection-string-or-key-or-SAS choice is expressible), `optional` tuning vars, and non-env `config`. Every variable is tagged `secret` and `readBy` (`"files-sdk"` vs the underlying SDK's `"sdk-chain"`, so AWS/GCS credential-chain vars aren't mislabeled as required). Helpers: `getProvider`, `listEnvVars`, `getSecretEnvVars`. `PROVIDER_NAMES` and the `Provider`/`ProviderSlug` types are also re-exported from the package root. Useful for sync engines, config UIs, and onboarding flows that need to enumerate providers and their required configuration up front.

### Patch Changes

- e80e922: Add `signal`, `timeout`, and `retries` to every operation. Set them on the `Files` constructor as defaults and override per call (a per-call value wins). `retries` is a number or `{ max, backoff }`; only `Provider` failures are retried — `NotFound`, `Unauthorized`, `Conflict`, aborts, and timeouts are returned immediately, and `ReadableStream` uploads are never retried because a consumed stream can't be replayed. The default backoff is exponential (`100 * 2 ** (attempt - 1)` ms, capped at 30s, no jitter); pass your own `backoff({ attempt, error })` for jitter or a different curve. `timeout` is applied per attempt and aborts the operation rather than triggering a retry. A `signal` always fails fast at the `Files` layer for every adapter; the underlying provider request is also cancelled on the S3 adapter and the S3-compatible catalog, Vercel Blob and UploadThing's fetch-backed reads, Azure, Google Drive, and PocketBase (across their operations), Supabase (`download` and `list` — the only methods its SDK lets a signal through), and the fetch-backed downloads of Box, Cloudinary, and Dropbox. Adapters whose SDK exposes no cancellation (GCS, Firebase Storage, Netlify Blobs, Appwrite, Bunny, Bun S3, and the R2 binding path) still fail fast at the `Files` layer but leave the in-flight request running.
- f774aa2: Add Azure AD / Managed Identity support to the Azure adapter via a `credential` (`TokenCredential`) option. Token-authenticated adapters mint User Delegation SAS URLs for `url()`, `signedUploadUrl()`, and same-container `copy()`, so signed URLs keep working without a storage account key. Set `useUserDelegationSas: false` to opt out of SAS signing for token-only setups.
- dbda237: Add a `prefix` option to the `Files` constructor. When set, every key is resolved relative to the prefix - reads, writes, copies, listings, URLs, and signed uploads - and the prefix is stripped back off the keys (and `name`) returned in results, so your application code works in its own namespace:

  ```ts
  const users = new Files({
    adapter: s3({ bucket: "uploads" }),
    prefix: "users",
  });

  await users.upload("123/avatar.png", file); // writes users/123/avatar.png
  const stored = await users.head("123/avatar.png");
  stored.key; // "123/avatar.png" - prefix stripped
  ```

  Leading and trailing slashes on the prefix are normalized (`"/users/"` and `"users"` behave identically), and `list()` scopes the underlying query on a path boundary so a `prefix: "users"` instance never matches the sibling `users-archive/`.

- d921741: Harden three internal regexes against polynomial ReDoS. The trailing-slash/`[. ]`-stripping patterns in `normalizePrefix` (core, used by every adapter's prefix handling), the `fs` adapter's Windows trailing-noise check, and the `bunny-storage` key parser each anchor with a `(?<!…)` lookbehind so the engine can't re-attempt the match at every character of a long trailing run (e.g. `"users////…"` or `"x.meta.json....    "`). Behavior is unchanged; only the worst-case matching cost is fixed.
- ff39a2e: fs adapter: reject keys that resolve to a `.meta.json` sidecar path — the adapter reserves that suffix for its per-object metadata sidecar, and accepting it as a regular key let a same-root caller silently overwrite, hide, or delete another key's sidecar (flipping the served `Content-Type`, mutating arbitrary `metadata` fields, or stripping the etag). The check runs on the resolved basename and folds case plus Windows trailing dots/spaces, so re-cased or normalized variants (`x.META.JSON`, `x.meta.json.`, `x.meta.json/`) that alias the sidecar on case-insensitive (APFS/NTFS) or Windows volumes are rejected too.
- 979cd00: Add Vercel OIDC authentication to the Vercel Blob adapter (`files-sdk/vercel-blob`). When the Blob store is connected to a Vercel project, the adapter now automatically picks up `VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID` and uses OIDC instead of the long-lived `BLOB_READ_WRITE_TOKEN` — OIDC tokens rotate automatically, which removes the risk that a static secret leaks from your codebase or environment. Two new options, `oidcToken` and `storeId`, let you pass OIDC credentials explicitly for runtimes (e.g. Vite) that don't load `.env.local` into `process.env`. Credential resolution mirrors the upstream SDK exactly: an explicit `token` always wins, then OIDC (option or env), then `BLOB_READ_WRITE_TOKEN`. The `url()` fast path now uses `storeId` (option or `BLOB_STORE_ID` env) when present so OIDC users keep the no-round-trip behavior, and `BLOB_STORE_ID` is accepted in either `store_<id>` or `<id>` form. Bumps the `@vercel/blob` peer dep floor to `^2.4.0`, which is the first version that ships the OIDC options.

## 1.4.0

### Minor Changes

- ef0d6af: Add Alibaba Cloud Object Storage Service (OSS) adapter (`files-sdk/alibaba`). Thin wrapper around the S3 adapter — endpoint derived from the region code (`oss-<region>.aliyuncs.com`), virtual-hosted-style addressing, errors relabelled as "Alibaba Cloud error". Auto-loads from `ALIBABA_ACCESS_KEY_ID` and `ALIBABA_ACCESS_KEY_SECRET`.
- d619709: Add `files` CLI for agents and scripts. One binary covers every adapter via `--provider <name>` with lazy imports — cold-start cost matches whichever single provider you select. Each `Adapter` method maps to a subcommand (`upload`, `download`, `head`, `exists`, `delete`, `copy`, `list`, `url`, `sign-upload`), with JSON-by-default output, `stdin`/`stdout` streaming for binary bodies, `--dry-run` and `--verbose` modes, and a stable exit-code mapping (`NotFound` → 1, `Provider` → 2, `Unauthorized` → 3, `Conflict` → 4). Provider credentials come from each adapter's existing env-var conventions, and `--config-json` is an escape hatch for the long tail of adapter options. `files ... mcp` boots a stdio MCP server exposing every command as a tool — provider and credentials bind at startup, so the agent only passes operation arguments.
- d0aec82: Add Cloudinary adapter (`files-sdk/cloudinary`). Defaults to `resource_type: "raw"` for arbitrary-bytes storage; switch to `image`/`video` for transforms. Reads `CLOUDINARY_URL` or individual `CLOUDINARY_*` env vars. Full Adapter surface including signed delivery URLs for `private`/`authenticated` types and form-POST signed upload URLs.
- 8b62142: Add Firebase Storage adapter (`files-sdk/firebase-storage`). Wraps the official `firebase-admin` SDK; the underlying `getStorage().bucket()` returns a `@google-cloud/storage` `Bucket`, so V4 signed read URLs, POST policy uploads with `maxSize`, server-side copy, and the full metadata round-trip all work out of the box. Auto-loads credentials from `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_STORAGE_BUCKET`, falling back to a service-account JSON path (`GOOGLE_APPLICATION_CREDENTIALS`) and then to Application Default Credentials. Accepts an existing `App` or `Bucket` via `app` to share initialization with Firestore/Auth. The bucket name defaults to `<projectId>.firebasestorage.app` when neither `bucket` nor `FIREBASE_STORAGE_BUCKET` is set. Firebase's `?alt=media&token=…` download-token URL form is out of scope for v1 — reach for `adapter.raw` if you need it.
- 8b62142: Add PocketBase adapter (`files-sdk/pocketbase`). Wraps the official `pocketbase` JS SDK and maps the unified key/blob API onto a dedicated collection: each upload becomes (or updates) a record whose configurable `keyField` (unique-indexed text, default `"key"`) holds the user-facing key and whose configurable `fileField` (single-value file, default `"file"`) holds the body. Auto-loads from `POCKETBASE_URL` plus either `POCKETBASE_ADMIN_EMAIL` + `POCKETBASE_ADMIN_PASSWORD` (admin login on first call) or `POCKETBASE_AUTH_TOKEN` (pre-issued token); accepts an existing `PocketBase` client via `client`. `url()` returns `pb.files.getURL()`, threading a short-lived file token from `pb.files.getToken()` for authenticated clients; set `publicBaseUrl` for a CDN override. `signedUploadUrl()` throws — PocketBase has no presigned upload primitive. `copy()` is read-then-write (no server-side copy). `list()` paginates via page number encoded as a numeric cursor string. `UploadOptions` `cacheControl` and `metadata` throw — PocketBase has no per-file HTTP cache headers and no arbitrary-metadata field on the file; add extra typed columns to the collection and write via `raw` if you need them. `responseContentDisposition` on `url()` throws — use `raw` and the `?download=true` query string instead.
- d0aec82: Add SharePoint adapter (`files-sdk/sharepoint`). Resolves `siteUrl` and named `documentLibrary` to a drive via Microsoft Graph, then delegates to the OneDrive adapter for file operations. Falls back to `SHAREPOINT_*` env vars then to `ONEDRIVE_*`. Resolution is lazy and cached after the first call.
- ef0d6af: Add Tencent Cloud Object Storage (COS) adapter (`files-sdk/tencent`). Thin wrapper around the S3 adapter — endpoint derived from the region code (`cos.<region>.myqcloud.com`), virtual-hosted-style addressing, errors relabelled as "Tencent Cloud error". Auto-loads from `TENCENT_SECRET_ID` and `TENCENT_SECRET_KEY`. Bucket name must include the `-<appid>` suffix per COS's namespacing.
- ef0d6af: Add Yandex Object Storage adapter (`files-sdk/yandex`). Thin wrapper around the S3 adapter — fixed global endpoint (`storage.yandexcloud.net`), region defaults to `ru-central1` for signing, virtual-hosted-style addressing, errors relabelled as "Yandex Cloud error". Auto-loads from `YANDEX_ACCESS_KEY_ID` and `YANDEX_SECRET_ACCESS_KEY`.
- de63748: Add Bun S3 adapter at `files-sdk/bun-s3`, backed by Bun's native `Bun.S3Client` instead of `@aws-sdk/client-s3`. Use this when you're already on Bun and want to skip the AWS SDK dependency. Implements the full adapter surface (upload, download, head, exists, delete, copy, list, url, signedUploadUrl) with three deliberate limitations vs `files-sdk/s3`: `copy()` is client-side (Bun has no server-side `CopyObject` primitive), and `upload(metadata|cacheControl)` plus `signedUploadUrl(maxSize)` throw because `Bun.S3Client` doesn't expose equivalent options. Pass `client: Bun.s3` to reuse the global singleton, or hand in any custom `Bun.S3Client`-shaped instance.
- 28e3243: Add Bunny Storage adapter (`files-sdk/bunny-storage`). Wraps the official `@bunny.net/storage-sdk` and connects to a Storage Zone via zone name + access key + region. Auto-loads from `BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_ACCESS_KEY` / `BUNNY_STORAGE_REGION`, with `STORAGE_*` accepted as aliases (the names used in the Bunny SDK's README). `url()` requires `publicBaseUrl` (typically a Bunny Pull Zone) and returns a permanent CDN URL — Bunny has no signed-read primitive, so `expiresIn` is ignored and `responseContentDisposition` throws. `signedUploadUrl()` throws because Bunny writes require the Storage API `AccessKey` header. `copy()` is a read-then-write (no server-side copy primitive in the SDK). Custom `metadata` and `cacheControl` on upload throw — configure cache behavior on the Pull Zone instead.
- 78bcf37: Move provider SDKs to optional peer dependencies. Installing `files-sdk` no longer pulls in every provider SDK by default — the package fully installs at a fraction of the previous size, and unused providers can't drag in transitive CVEs. Install only what you use:

  ```sh
  # S3 (and any S3-compatible: R2, MinIO, DigitalOcean Spaces, …)
  npm install files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner

  # GCS
  npm install files-sdk @google-cloud/storage google-auth-library

  # Azure
  npm install files-sdk @azure/storage-blob @azure/identity
  ```

  **Breaking (install-time only):** if you upgrade and your project doesn't list the relevant provider SDK in its own `package.json`, the next adapter import will throw `ERR_MODULE_NOT_FOUND`. Fix is one `npm install`. The published JS for each adapter subpath (`files-sdk/s3`, `files-sdk/gcs`, …) is byte-identical to the previous release — provider SDKs were already externalized, so runtime behavior, tree-shaking, and bundle sizes don't change. The `files` CLI keeps `commander` as a regular dep, so `npx files` works out of the box. Fixes #34.

### Patch Changes

- a53be2d: Expand adapter test coverage for error-recovery branches that were previously unexercised: `exists()` swallowing a thrown `NotFound` (azure, gcs, netlify-blobs, r2) versus rethrowing other mapped errors; the supabase stream-download error envelope; and dropbox's `exists()` returning false for `folder`/`deleted` `.tag`s plus the `shared_link_already_exists` recovery falling through when no usable URL is embedded. No runtime behavior changes.

## 1.3.0

### Minor Changes

- 2d3a569: Add Appwrite adapter at `files-sdk/appwrite` exporting `appwrite()`, a wrapper around the official `node-appwrite` SDK's `Storage` API. Auto-loads `endpoint`, `projectId`, and `key` from `APPWRITE_ENDPOINT` / `APPWRITE_PROJECT_ID` / `APPWRITE_API_KEY` (with `NEXT_PUBLIC_*` fallbacks for the first two), or accepts an existing `Client` or `Storage` instance via `client`. `list({ prefix })` is forwarded as a `startsWith("$id", prefix)` query against the canonical file ID — files created outside the adapter where the display `name` differs from `$id` won't be matched by prefix. `upload()` buffers stream bodies up-front since `InputFile.fromBuffer` has no streaming form, throws on `UploadOptions.cacheControl` and non-empty `UploadOptions.metadata` (Appwrite has no equivalent fields), and silently ignores `UploadOptions.contentType` (Appwrite auto-detects mime from the payload). `copy()` is read-then-write — Appwrite has no server-side copy primitive, so it costs an egress + an ingest and is not atomic. `url()` throws by default (Appwrite SDKs cannot mint signed read URLs with API keys); set `public: true` on a public bucket to return the constructed permanent `view` URL. `signedUploadUrl()` throws — Appwrite has no presigned upload primitive; use JWTs or the client SDK for direct uploads. Keys (Appwrite file IDs) must start with `[a-zA-Z0-9]` and use only `[a-zA-Z0-9._-]`, max 36 characters — invalid keys throw a `FilesError("Provider", ...)` before the API call. Errors are relabelled as `Appwrite error`, with `404`/`401`+`403`/`409` mapped to `NotFound`/`Unauthorized`/`Conflict`.
- ed87e51: Add Backblaze B2 adapter at `files-sdk/backblaze-b2`, a thin S3 wrapper that derives the endpoint from the cluster code (`s3.<region>.backblazeb2.com`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`. Errors are relabelled as `Backblaze B2 error` and `publicBaseUrl` accepts B2's friendly download URL prefix for skipping signing on public buckets.
- 2a35ce1: Add `exists(key)` to the Files API. Returns `true` when the object exists and `false` when the adapter reports a not-found error, without fetching the object body. Implemented across all built-in adapters.
- 8ae51f0: Add Exoscale Object Storage (SOS) adapter at `files-sdk/exoscale`, a thin S3 wrapper that derives the endpoint from the zone code (`sos-<region>.exo.io` — `ch-gva-2`, `ch-dk-2`, `de-fra-1`, `de-muc-1`, `at-vie-1`, `at-vie-2`, `bg-sof-1`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `EXOSCALE_API_KEY` / `EXOSCALE_API_SECRET`. Exoscale calls these zones but they fill the SigV4 region slot. Errors are relabelled as `Exoscale error`.
- 2c52f56: Add `files.file(key)` to return a `FileHandle` bound to a single key. The handle exposes `upload`, `download`, `head`, `exists`, `delete`, `url`, `signedUploadUrl`, `copyTo`, and `copyFrom` without re-passing the key each time. It's a thin wrapper over the same `Files` methods, so adapters do not need to implement anything extra.
- 8ae51f0: Add Filebase adapter at `files-sdk/filebase`, a thin S3 wrapper around Filebase's S3-compatible gateway in front of decentralized storage networks (IPFS, Sia, Storj — the backing network is chosen per-bucket in the dashboard). Uses the fixed `https://s3.filebase.com` endpoint with virtual-hosted-style addressing, defaults the SigV4 region to `"us-east-1"`, and auto-loads credentials from `FILEBASE_ACCESS_KEY_ID` / `FILEBASE_SECRET_ACCESS_KEY`. `publicBaseUrl` accepts an IPFS/Sia/Storj gateway prefix for skipping signing on public objects. Errors are relabelled as `Filebase error`.
- 8ae51f0: Add IBM Cloud Object Storage adapter at `files-sdk/ibm-cos`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.cloud-object-storage.appdomain.cloud` — `us-south`, `us-east`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `br-sao`, `ca-tor`, …), defaults to virtual-hosted-style addressing, and auto-loads credentials from `IBM_COS_ACCESS_KEY_ID` / `IBM_COS_SECRET_ACCESS_KEY`. Auth uses IBM Cloud's HMAC credentials (tick "Include HMAC Credential" in the service-credential Advanced options), not IAM API keys. For direct (no-egress) access from inside the same IBM Cloud region, pass `https://s3.direct.<region>.cloud-object-storage.appdomain.cloud` as an explicit `endpoint`. Errors are relabelled as `IBM Cloud Object Storage error`.
- 8ae51f0: Add iDrive e2 adapter at `files-sdk/idrive-e2`, a thin S3 wrapper that takes an explicit `endpoint` (iDrive e2 hostnames are tied to the provisioned bucket cluster and don't follow a public pattern — copy it from the iDrive e2 dashboard under Access Keys → Endpoint), defaults the SigV4 region to `"us-east-1"`, and auto-loads credentials from `IDRIVE_E2_ACCESS_KEY_ID` / `IDRIVE_E2_SECRET_ACCESS_KEY`. Errors are relabelled as `iDrive e2 error`.
- 8ae51f0: Add Oracle Cloud Infrastructure Object Storage adapter at `files-sdk/oracle-cloud`, a thin S3 wrapper around OCI's S3 compatibility layer. Requires both the tenancy `namespace` and a `region` to derive the endpoint (`<namespace>.compat.objectstorage.<region>.oraclecloud.com`); defaults to path-style addressing since OCI's wildcard TLS cert doesn't cover bucket subdomains under the namespace-prefixed host. Auth uses OCI's HMAC _Customer Secret Keys_ (distinct from regular API signing keys); credentials auto-load from `OCI_ACCESS_KEY_ID` / `OCI_SECRET_ACCESS_KEY`. Errors are relabelled as `Oracle Cloud error`.
- 8ae51f0: Add OVHcloud Object Storage adapter at `files-sdk/ovhcloud`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.io.cloud.ovh.net` — High Performance S3 tier), defaults to virtual-hosted-style addressing, and auto-loads credentials from `OVH_ACCESS_KEY_ID` / `OVH_SECRET_ACCESS_KEY`. For the Standard (Swift-backed) tier, pass `https://s3.<region>.cloud.ovh.net` as an explicit `endpoint`. Errors are relabelled as `OVHcloud error`.
- 8ae51f0: Add Scaleway Object Storage adapter at `files-sdk/scaleway`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.scw.cloud` — `fr-par`, `nl-ams`, `pl-waw`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `SCW_ACCESS_KEY` / `SCW_SECRET_KEY`. Errors are relabelled as `Scaleway error`.
- ed87e51: Add Tigris adapter at `files-sdk/tigris`, a thin S3 wrapper around Tigris's globally-distributed object storage. Uses the fixed `https://fly.storage.tigris.dev` endpoint with virtual-hosted-style addressing, defaults the SigV4 region to `"auto"` since Tigris doesn't route by region, and auto-loads credentials from `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY`. Errors are relabelled as `Tigris error`.
- 8ae51f0: Add Vultr Object Storage adapter at `files-sdk/vultr`, a thin S3 wrapper that derives the endpoint from the region code (`<region>.vultrobjects.com` — `ewr`, `sjc`, `ams`, `blr`, `del`, `sgp`, `lux`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `VULTR_ACCESS_KEY_ID` / `VULTR_SECRET_ACCESS_KEY`. Errors are relabelled as `Vultr error`.
- ed87e51: Add Wasabi adapter at `files-sdk/wasabi`, a thin S3 wrapper that derives the endpoint from the region code (`s3.<region>.wasabisys.com`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `WASABI_ACCESS_KEY_ID` / `WASABI_SECRET_ACCESS_KEY`. Region names mirror AWS but the endpoints are Wasabi's own; errors are relabelled as `Wasabi error`.

### Patch Changes

- 2aa92e1: URL-encode keys in `joinPublicUrl` to prevent injection attacks via special characters (`?`, `#`, spaces) in file keys. Uses segment-by-segment encoding to preserve `/` as a path separator.

  **Note:** Pass raw keys — this function handles encoding. Pre-encoded keys will be double-encoded (e.g. `%20` becomes `%2520`).

- 8982c51: Expand test coverage for `box`, `fs`, `onedrive`, `supabase`, and `openai/responses` adapters. Adds tests covering `mapBoxError` / `mapGraphError` non-API error shapes, trailing-slash key handling, no-extension content-type inference, cache-miss reuse and non-file conflict paths in Box, trailing-slash URL trimming in Supabase, and ENOENT mid-page plus non-ENOENT walk errors in the fs adapter. No behavior changes.

## 1.2.0

### Minor Changes

- 9758347: Add AI SDK tools subpath (`files-sdk/ai-sdk`) exporting `createFileTools(...)` — wraps a configured `Files` instance as a set of Vercel AI SDK tools (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) ready to plug into `generateText` / `streamText` / any agent. Mirrors `@github-tools/sdk`'s ergonomics: write tools require approval by default (configurable globally or per-tool via `requireApproval`), `readOnly: true` strips writes entirely, and `overrides` lets callers patch tool descriptions/titles/etc. without touching `execute`. Individual tool factories (`uploadFile`, `downloadFile`, …) are also exported for cherry-picking. `ai` and `zod` are optional peer dependencies — only required when consuming the new subpath.
- 2d811b1: Add Claude Agent SDK tools subpath (`files-sdk/claude`) exporting `createClaudeFileTools(...)` — wraps a configured `Files` instance as an in-process MCP server ready to drop into `query()` from [`@anthropic-ai/claude-agent-sdk`](https://docs.claude.com/en/api/agent-sdk/overview) (the renamed Claude Code SDK).

  The Claude Agent SDK consumes tools differently than the OpenAI/Vercel adapters: tools are bundled into an `SdkMcpServer` and surfaced to the agent via `mcpServers` + `allowedTools`, with approval enforced through a top-level `canUseTool` callback. The factory returns all four pieces:

  ```ts
  const tools = createClaudeFileTools({ files });

  for await (const msg of query({
    prompt: "List my files.",
    options: {
      mcpServers: tools.mcpServers,
      allowedTools: tools.allowedTools,
      canUseTool: tools.canUseTool,
    },
  })) {
    /* ... */
  }
  ```

  Same eight file operations as the other AI subpaths (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) with the same approval-gating defaults, `readOnly` mode, and per-tool `overrides` (description + MCP `annotations`). The bundled `canUseTool` denies approval-gated writes; compose your own using `tools.needsApproval(name)` for human-in-the-loop UX — it accepts both bare names (`"uploadFile"`) and the MCP-prefixed form (`"mcp__files__uploadFile"`) the SDK passes in. The MCP server name defaults to `"files"` and is configurable via `serverName`, which also flows through to the `mcp__<server>__*` strings in `allowedTools`. Read tools get a `readOnlyHint` annotation; writes get `destructiveHint` (`copyFile` / `signUploadUrl` use `idempotentHint` instead).

  Individual tool factories (`claudeUploadFile`, `claudeDownloadFile`, …) are also exported as `SdkMcpToolDefinition` instances for callers that want to compose their own `createSdkMcpServer` rather than use the bundled one. `@anthropic-ai/claude-agent-sdk` and `zod` are optional peer dependencies — only required when consuming the new subpath.

- d6adeae: Add OpenAI tools subpath (`files-sdk/openai`) with two factories:

  - `createResponsesFileTools(...)` — for OpenAI's native [Responses API](https://platform.openai.com/docs/api-reference/responses). Returns `{ definitions, execute, needsApproval }`. `definitions` is the array of function-tool specs to pass into `openai.responses.create({ tools })`. `execute(call)` runs a `function_call` item and returns a `function_call_output` ready to push into the next turn's input — JSON parse failures and Zod validation errors come back as the tool's output so the model can self-correct.
  - `createAgentsFileTools(...)` — for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`). Returns a record of `tool()` outputs ready to spread into `new Agent({ tools })`.

  Both wrap the same eight file operations as `files-sdk/ai-sdk` (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) with the same approval-gating defaults, `readOnly` mode, and per-tool overrides. Schemas + execute logic are extracted to a shared internal module so the three subpaths can't drift apart.

  `openai` and `@openai/agents` are optional peer dependencies — install only the one(s) you use. The subpath requires Zod 4.

## 1.1.2

### Patch Changes

- 6edb433: `googleDrive` and `onedrive` adapters now auto-load credentials from `process.env` when not passed explicitly, matching the convention already in place for the other adapters. `googleDrive()` reads `GOOGLE_DRIVE_CLIENT_EMAIL` + `GOOGLE_DRIVE_PRIVATE_KEY` (service-account credentials) or `GOOGLE_DRIVE_KEY_FILE` (path to a service-account JSON), plus `GOOGLE_DRIVE_SUBJECT` for domain-wide delegation, `GOOGLE_DRIVE_ID` to target a Shared Drive, and `GOOGLE_DRIVE_ROOT_FOLDER_ID` to override the bucket root (when only `GOOGLE_DRIVE_ID` is set, `rootFolderId` defaults to the drive id so Shared Drives work with no extra config). `onedrive()` reads `ONEDRIVE_ACCESS_TOKEN` (static token) or the `ONEDRIVE_TENANT_ID` + `ONEDRIVE_CLIENT_ID` + `ONEDRIVE_CLIENT_SECRET` triple (client-credentials/app-only auth), plus `ONEDRIVE_DRIVE_ID` / `ONEDRIVE_SITE_ID` / `ONEDRIVE_USER_ID` to target a specific drive — the existing "client-credentials needs a target" guard still applies. Explicit options continue to take precedence over env vars; missing-auth error messages now mention the env fallback names.

## 1.1.1

### Patch Changes

- bd31113: Fix release workflow referencing a non-existent `VERCEL_PROJECT_ID_WEB` secret; now reads `VERCEL_PROJECT_ID` to match the configured repository secret so the post-publish Vercel deploy succeeds.

## 1.1.0

### Minor Changes

- 510cde5: Add Akamai Cloud Object Storage adapter (`files-sdk/akamai`), formerly Linode Object Storage. Thin wrapper over the S3 adapter with Akamai defaults: endpoint derived from the `region` cluster code (`us-iad-1`, `nl-ams-1`, `fr-par-1`, the older `us-east-1`/`eu-central-1`/`ap-south-1` clusters, etc.) as `https://<region>.linodeobjects.com` and overridable, virtual-hosted-style addressing, `"Akamai error"` provider label, and `AKAMAI_ACCESS_KEY_ID` / `AKAMAI_SECRET_ACCESS_KEY` env-var fallbacks. `publicBaseUrl` accepts a public-bucket origin (`https://<bucket>.<region>.linodeobjects.com`) or a custom CNAME for unsigned URLs; otherwise `url()` returns a presigned GetObject (1-hour default).
- f40e0d3: Add Box adapter (`files-sdk/box`) for personal Box and Box Enterprise via the official `box-typescript-sdk-gen` SDK. Box files live by ID rather than by path, so the adapter walks `rootFolderId` and translates virtual keys (`docs/a.txt`) into nested Box subfolders, auto-creating intermediate folders on `upload()` and racing-recovering on `item_name_in_use`. Five auth shapes (pre-built `client`, `developerToken`, `oauth` with refresh-token seeding, `ccg` with `enterpriseId` or `userId`, and `jwt` with `configJsonString` or `configFilePath`) cover scripts, user apps, and enterprise installs; env-var fallback via `BOX_DEVELOPER_TOKEN`. Token lifecycle is handled by the SDK's built-in `Authentication` classes — no manual refresh bookkeeping. Direct `upload()` uses single-call `uploads.uploadFile` up to 50 MB and switches to `chunkedUploads.uploadBigFile` automatically; existing leaf names route through `uploadFileVersion` (overwrite). `url()` mints a signed download URL via `getDownloadFileUrl` by default; with `publicByDefault: true`, `upload()` also calls `addShareLinkToFile` (open access) and `url()` returns the link's `download_url`; `responseContentDisposition` always throws (no override on Box URLs). `signedUploadUrl()` throws — Box uploads require a multipart POST with both an `attributes` JSON part and the file bytes part, which fits neither the SDK's PUT-with-headers nor POST-with-form-fields shape; use `upload()` server-side or Box's UI Elements / Content Uploader for browser flows. `list()` returns immediate-children files only at `rootFolderId` (no recursion, subfolders filtered out, prefix matched client-side, offset encoded as a numeric cursor). User `metadata` and `cacheControl` throw (Box exposes file metadata via classifications and metadata templates — drop to `raw.fileMetadata.*` if you need it).
- 54edb1b: Add DigitalOcean Spaces adapter (`files-sdk/digitalocean-spaces`). Thin wrapper over the S3 adapter with Spaces defaults: endpoint derived from `region` (`https://${region}.digitaloceanspaces.com`), virtual-hosted addressing, `"Spaces error"` provider label, and `DO_SPACES_KEY` / `DO_SPACES_SECRET` env-var fallbacks. `publicBaseUrl` accepts a Spaces CDN host (`https://${bucket}.${region}.cdn.digitaloceanspaces.com`) or a custom CNAME.
- c841bbb: Add Dropbox adapter (`files-sdk/dropbox`) for personal Dropbox and Dropbox Business via the official `dropbox` SDK. Path-addressable like OneDrive, so virtual keys map directly to Dropbox paths — no virtual-key cache. Four auth shapes (pre-built `client`, static or callable `accessToken`, OAuth refresh-token flow with `refreshToken` + `appKey` (+ optional `appSecret`), and env-var fallback via `DROPBOX_ACCESS_TOKEN` or `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` (+ `DROPBOX_APP_SECRET`)). Refresh tokens are exchanged at `api.dropboxapi.com/oauth2/token` and cached until ~60s before expiry. `url()` mints a 4-hour temporary link via `filesGetTemporaryLink` by default; with `publicByDefault: true`, `upload()` also creates a public shared link and `url()` returns it (rewritten to `?dl=1` for direct download); `expiresIn` is capped at Dropbox's 14400s (4h) maximum and `responseContentDisposition` always throws (no override on Dropbox links). `signedUploadUrl()` throws — Dropbox's temporary upload link expects POST with a raw body, which fits neither the SDK's PUT-with-headers nor POST-with-form-fields shape; use `upload()` or drop to `raw.filesGetTemporaryUploadLink(...)`. Direct `upload()` uses single-call `filesUpload` up to 150 MB and switches to `filesUploadSession*` (chunked, up to 350 GB) automatically; user `metadata` and `cacheControl` throw (Dropbox files have no native arbitrary-metadata field — use `raw` with `property_groups` if you need it).
- 5ff9d79: Add Google Drive adapter (`files-sdk/google-drive`) via the official `@googleapis/drive` v3 client. Drive has no native key field, so the adapter maps virtual keys onto `appProperties.fsdkKey` and amortizes lookups with a per-instance LRU cache (configurable via `fileIdCacheSize`, defaults to 1024). Three auth shapes: inline service-account `credentials`, a `keyFilename` JSON path, or 3-legged `oauth` refresh tokens — plus a pre-built `client` escape hatch (note: `signedUploadUrl()` requires an auth handle and throws when constructed via `client`). `signedUploadUrl()` initiates a Drive resumable session and returns the session URL as a one-shot PUT (`maxSize` is forwarded as `X-Upload-Content-Length` advisory only; `minSize` is ignored). `url()` requires `publicByDefault: true` (grants `anyone, reader` on upload and returns the permanent Drive download URL); `expiresIn` ignored, `responseContentDisposition` always throws. Service-account workloads should target a Shared Drive via `driveId` to avoid the 15 GB personal quota. Caller `metadata` keys starting with `fsdk` are reserved.
- 2a84ef2: Add Hetzner Object Storage adapter (`files-sdk/hetzner`). Thin wrapper over the S3 adapter with Hetzner defaults: endpoint derived from the `region` location code (`fsn1`, `nbg1`, `hel1`) as `https://<region>.your-objectstorage.com` and overridable, virtual-hosted-style addressing, `"Hetzner error"` provider label, and `HCLOUD_ACCESS_KEY_ID` / `HCLOUD_SECRET_ACCESS_KEY` env-var fallbacks. `publicBaseUrl` accepts a custom CNAME or proxy host for unsigned URLs; otherwise `url()` returns a presigned GetObject (1-hour default).
- b4fd387: Add Netlify Blobs adapter (`files-sdk/netlify-blobs`). Wraps the `@netlify/blobs` SDK with site-scoped or deploy-scoped stores, configurable consistency, and a metadata round-trip that packs `contentType`/`size`/`lastModified`/`cacheControl` plus user metadata into Netlify's metadata map so `head()`/`download()` return rich fields. Auto-detects credentials from Netlify's runtime context (`NETLIFY_BLOBS_CONTEXT`) when available, with explicit `siteID`/`token` overrides falling back to `NETLIFY_SITE_ID` / `NETLIFY_API_TOKEN` / `NETLIFY_BLOBS_TOKEN`. `copy()` is read-then-write since Netlify has no native copy primitive; `list()` returns key + etag (rich metadata requires a per-item `head()`); `url()` and `signedUploadUrl()` throw because Netlify Blobs has no public URL or presigned-upload primitive.
- 0d5af66: Add OneDrive adapter (`files-sdk/onedrive`) for OneDrive personal, OneDrive for Business, and SharePoint document libraries via Microsoft Graph (`@microsoft/microsoft-graph-client` + `@azure/identity`). Path-addressable like the underlying API, so virtual keys map onto real OneDrive paths — no virtual-key cache, no reserved-metadata namespace. Four auth shapes (`clientCredentials` for app-only, `oauth` for delegated refresh-token flow, `accessToken` for caller-managed tokens, and a pre-built `client` escape hatch) and four drive targets (`/me/drive`, `driveId`, `siteId`, `userId`). `signedUploadUrl()` returns a Graph upload-session URL (one-shot PUT, advisory `maxSize`/`minSize`); `url()` requires `publicByDefault: true` and creates an anonymous-view share link (Graph has no signed URL primitive, `expiresIn` ignored). `copy()` polls Graph's async copy monitor with a configurable `copyTimeoutMs`. Direct `upload()` is capped at OneDrive's 250 MB simple-upload limit; user `metadata` and `cacheControl` throw (Graph drive items have no native arbitrary-metadata field — use `raw` for Open Extensions).
- 7251d42: Add Storj adapter (`files-sdk/storj`). Thin wrapper over the S3 adapter with Storj defaults: `endpoint` defaults to `https://gateway.storjshare.io` (Gateway MT, the hosted multi-tenant gateway) and is overridable for self-hosted Gateway ST, path-style addressing on, region defaulted to `us-east-1` (the gateway ignores it for routing), `"Storj error"` provider label, and `STORJ_ACCESS_KEY_ID` / `STORJ_SECRET_ACCESS_KEY` env-var fallbacks. `publicBaseUrl` accepts a linksharing prefix like `https://link.storjshare.io/raw/<accessGrant>/<bucket>` for unsigned URLs.
- 37be6fc: Add UploadThing adapter (`files-sdk/uploadthing`). Maps the user-supplied key onto UploadThing's `customId`, supports public-read and private ACLs, signs UFS presigned PUT URLs via Web Crypto HMAC-SHA256, and falls back to HEAD-on-URL for `head()` and read-then-write for `copy()` since UploadThing has no native primitives for those.

### Patch Changes

- 0ec97d0: Extract shared adapter helpers into `src/internal/core.ts` so authoring a new adapter is less boilerplate. The new module exports `DEFAULT_URL_EXPIRES_IN`, `joinPublicUrl`, `resolveUrlStrategy` (the two-state public-vs-sign decision, with `responseContentDisposition` always forcing signing), `normalizeBody` (Body → `Uint8Array | ReadableStream<Uint8Array>` + content-type/length), and `makeErrorMapper` (factory for the per-provider `mapXError` scaffold — code-set lookup, HTTP-status fallback, `FilesError` pass-through). The s3, azure, gcs, supabase, r2, fs, and uploadthing adapters now consume these helpers; supabase keeps its own `normalizeBody` because Blob pass-through is required for multipart uploads, and r2's `url()` keeps its three-state hybrid logic. `mapS3Error` retains its 2-arg legacy signature for the S3-compatible wrappers (R2 HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai). No public-API changes.
- 30d3634: Improve test coverage and remove dead code in the fs adapter. Adds tests for r2's HTTP-path delegation (copy/delete/download/head/list/signedUploadUrl proxies to the lazy-loaded inner s3 adapter, plus the `raw` getter's pre/post-init behavior) and for fs uploads with `ArrayBuffer` and `ArrayBufferView` bodies plus rejection of keys that resolve to the adapter root. Drops the unreachable `ReadableStream` branch in `fs/bodyToBytes` — stream uploads route through `writeStreamToTempThenRename`, so the parameter type is narrowed to `Exclude<Body, ReadableStream<Uint8Array>>` to enforce that at the type level.

  Further hardens coverage of edge paths across the fs, azure, supabase, r2, and stored-file modules: corrupt/partial sidecar JSON handling, lazy-body errors when an underlying file is removed, atomic upload cleanup when rename fails (buffer + stream paths), non-ENOENT delete errors, Azure stream downloads with missing `readableStreamBody`, anonymous Azure copy source URLs, Supabase numeric `statusCode` fallback and Date/number `lastModified` parsing, R2 binding copy with put failure, and concurrent reads on a lazy `StoredFile` sharing the in-flight cache promise.

## 1.0.0

### Major Changes

- 30900e6: Initial release
