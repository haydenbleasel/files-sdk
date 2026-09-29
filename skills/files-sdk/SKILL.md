---
name: files-sdk
description: Use files-sdk to add file storage to a TypeScript/JavaScript app with a unified API across 48 adapters (S3, R2, GCS, Azure, Vercel Blob, the local filesystem, and more). Triggers when the user wants to upload/download/list/search/move/delete/copy files, generate presigned URLs, do multipart or resumable uploads, range downloads, conditional (ETag) writes, bulk (array) operations, migrate or mirror between providers, list folders, scope to a prefix, observe activity with hooks, add plugins (encryption, validation, versioning, caching, …), expose storage to the browser with `useFiles` and a server gateway, use the `files` CLI or its MCP server, expose storage to an AI agent (Vercel AI SDK, OpenAI Responses/Agents, Claude Agent SDK), or asks about "files-sdk", "Files SDK", `new Files(...)`, `createFiles(...)`, `files.upload`, `files.move`, `files.url`, `files.signedUploadUrl`, `files.search`, `transfer(...)`, `sync(...)`, `UploadControl`, or any `files-sdk/<adapter>` subpath import.
---

# files-sdk

A unified storage SDK for object and blob backends. One small API. Web-standard I/O. Escape hatch to the native client when needed.

When the user asks for help integrating it, follow this skill. It is the source of truth — prefer it over training-data memory of the package.

> **Bundled docs:** When `files-sdk` is installed, the full documentation ships inside the package at `node_modules/files-sdk/docs`. Read those MDX files for the complete, version-matched reference: per-adapter setup under `docs/adapters/`, concept pages (bulk, multipart, resumable, retries, prefixes, capabilities, conditional operations, …) under `docs/(concepts)/`, the method reference under `docs/api/`, plugins under `docs/plugins/`, the browser/gateway layer under `docs/ui/`, AI tools under `docs/ai/`, the CLI under `docs/cli/`, plus `index`, `installation`, `usage`, `providers`, `faq`, and `troubleshooting`. Prefer them over <https://files-sdk.dev> when the package is present locally — they match the installed version exactly.

## Mental model

- One core class `Files`, configured once with an adapter at construction time. The adapter is fixed for the life of the instance.
- 48 adapters, each a separate subpath export so only what you import is bundled (`files-sdk/s3`, `files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, `files-sdk/vercel-blob`, `files-sdk/fs`, …).
- The unified API is the **common subset** of what every adapter can do. Provider-specific features (S3 versioning, lifecycle, storage classes, etc.) live behind `files.raw`, which returns the underlying native client.
- Bodies are web-standard: `Blob`, `File`, `ReadableStream<Uint8Array>`, `Uint8Array`, `ArrayBuffer`, `ArrayBufferView`, or `string`. No provider types leak.
- Every method takes the same `OperationOptions` (`signal`, `timeout`, `retries`), and most of those can also be set once on the constructor as instance defaults. The constructor additionally takes `prefix`, `readonly`, `hooks`, `plugins` (see [Plugins](#plugins)), and `receipts` (opt-in provenance records on `onAction`).
- Where an adapter can't do something the unified surface offers (a range download, a folder listing, a resumable session), it **throws a `FilesError` rather than silently degrading** — so a missed capability is loud, not a quiet correctness bug. `files.capabilities` (or the adapter's `supportsRange` / `supportsDelimiter` flags) lets you branch at runtime.

## Install

```sh
npm install files-sdk
```

## Quick start

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads" }),
});

await files.upload("avatars/abc.png", file, { contentType: "image/png" });
const got = await files.download("avatars/abc.png");
const exists = await files.exists("avatars/abc.png");
```

Swap the adapter import and the rest of the code stays the same.

## Core API

All methods live on the `Files` instance; the single-key forms are also available on a key-scoped `FileHandle` from `files.file(key)`. The `upload`/`download`/`head`/`exists`/`delete` methods are **overloaded** — pass one key for a single result, or an array for the bulk form (see [Bulk operations](#bulk-operations)).

| Method | Returns | Notes |
| --- | --- | --- |
| `upload(key, body, opts?)` | `UploadResult` | `opts`: `contentType`, `cacheControl`, `metadata`, `onProgress`, `multipart`, `control`, `condition`. Array form → `{ uploaded, errors? }`. |
| `download(key, opts?)` | `StoredFile` | `opts.as` is `"blob"` or `"stream"`; `opts.range` for a byte slice. Array form → `{ downloaded, errors? }`. |
| `head(key, opts?)` | `StoredFile` | Metadata only. The returned object still has `text()`/`blob()`/`arrayBuffer()`/`stream()` but they lazy-GET. Array form → `{ files, errors? }`. |
| `exists(key, opts?)` | `boolean` | `false` only on `NotFound`. Auth/transport errors still throw. Array form → `{ existing, missing, errors? }`. |
| `delete(key, opts?)` | `void` | Array form → `{ deleted, errors? }` (uses native batch delete on S3-family, Azure, Supabase, UploadThing). |
| `copy(from, to, opts?)` | `void` | Within one adapter. |
| `move(from, to, opts?)` | `void` | Rename. Native rename where available (`fs`, FTP, SFTP, WebDAV, Cloudinary, memory), else copy+delete. Throws on immutable stores (Convex). |
| `list(opts?)` | `{ items, prefixes?, cursor? }` | `opts`: `prefix`, `cursor`, `limit`, `delimiter`. `delimiter` returns folder `prefixes` — see [Folder listing](#folder-listing). |
| `listAll(opts?)` | `AsyncGenerator<StoredFile>` | Walks every page for you, following the cursor. `for await (const f of files.listAll({ prefix }))`. |
| `search(pattern, opts?)` | `AsyncGenerator<StoredFile>` | Key match over every page: a glob by default (`photos/**/*.jpg`), a `RegExp`, or `match: "regex" \| "substring" \| "exact"`. `opts`: `prefix`, `maxResults`, `caseInsensitive`, `limit`. |
| `url(key, opts?)` | `string` | See [URL behavior](#url-behavior) — varies by adapter. |
| `signedUploadUrl(key, opts)` | `SignedUpload` | See [Signed upload URLs](#signed-upload-urls) — pass `maxSize`. |
| `file(key)` | `FileHandle` | Same single-key methods, key pre-bound. Also `copyTo`/`copyFrom`/`moveTo`/`moveFrom`. |
| `capabilities` (getter) | `AdapterCapabilities` | What the adapter can do: `rangeRead`, `delimiter`, `metadata`, `cacheControl`, `multipart`, `serverSideCopy`, `uploadProgress`, `signedUrl`, `conditional`. Plugins can narrow it (see [Plugins](#plugins)). Branch on it up front instead of catching a throw. |
| `raw` / `adapter` (getters) | native client / `Adapter` | Escape hatch — see [Escape hatch](#escape-hatch). |
| `readonly()` (method) | `Files` | A read-only view reusing the same adapter/prefix/hooks — see [Instance options](#instance-options). |

Plus top-level `transfer(source, dest, opts?)` for a one-shot cross-provider migration and `sync(source, dest, opts?)` to mirror only new or changed objects — see [Bulk, move & transfer](#bulk-move--transfer).

### `StoredFile` shape

`name`, `key`, `size`, `type`, `lastModified?`, `etag?`, `metadata?`, plus `arrayBuffer()`, `text()`, `blob()`, `stream()`.

### Conditional operations

`condition` applies an ETag predicate inside the provider request — never a `head()` + write race:

```ts
const created = await files.upload("state.json", body, {
  condition: { type: "create" }, // only if absent
});
await files.upload("state.json", next, {
  condition: { type: "replace", etag: created.etag }, // compare-and-set
});
```

`download` and `delete` take `condition: { etag }`; `copy` takes `condition: { source: { etag }, destination: { type: "create" } }`. A failed predicate rejects with `FilesError`; an adapter without the native primitive rejects before any I/O (check `files.capabilities.conditional`). Not available on bulk, multipart, or resumable uploads.

### File handles

For repeated work on the same key:

```ts
const avatar = files.file("avatars/abc.png");

await avatar.upload(file, { contentType: "image/png" });
if (await avatar.exists()) {
  const meta = await avatar.head();
  const url = await avatar.url({ expiresIn: 300 });
}
await avatar.moveTo("avatars/archived/abc.png");
await avatar.delete();
```

## Instance options

Pass these to `new Files({ adapter, ... })`. The three `OperationOptions` (`signal`, `timeout`, `retries`) are also accepted per-call, where a per-call value wins.

- **`prefix`** — every key is resolved relative to it: prepended on the way in, stripped from results on the way out (including in `list`, hooks, and bulk forms). Your app code works in its own namespace. `new Files({ adapter, prefix: "users" })` → `upload("123/a.png")` writes `users/123/a.png` and the result's `key` is `"123/a.png"`.
- **`readonly: true`** — blocks every write surface (`upload`, `delete`, `copy`, `move`, `signedUploadUrl`, and the `file(key)` write helpers) with `FilesError { code: "ReadOnly" }`. Reads still work. `files.readonly()` derives such a view from an existing instance (same adapter/prefix/timeout/retries/hooks, no second client). Does **not** lock down `files.raw`. `files.isReadOnly` reports whether an instance is read-only.
- **`hooks`** — fire-and-forget observability: `onAction` (fires once per settled call, success or error, with `type`/`key`/`keys`/`from`/`to`/`status`/`result`/`durationMs`), `onError` (rejections), `onRetry` (each scheduled retry). Caller-facing payloads only — never the internal prefixed path. A throwing hook can't fail the operation.
- **`signal`** — an `AbortSignal`; aborting fails in-flight single-key calls fast with `FilesError { aborted: true }` (still `code: "Provider"`). Constructor + per-call signals compose (either aborts).
- **`timeout`** — per-attempt deadline in ms (not per call). Aborts and is **not** retried. `0`/negative disables. No default.
- **`retries`** — a number (`{ max }`) or `{ max, backoff }`. Retries only transient `Provider` failures; `NotFound`/`Unauthorized`/`Conflict`, aborts, timeouts, and `ReadableStream` uploads are never retried. Default backoff is exponential (100ms·2ⁿ, capped 30s).

> **Bulk forms don't take `signal` or `retries`** — they manage work through `concurrency`/`stopOnError` and surface per-key failures in `errors[]` instead. See [references/resilience-and-hooks.md](references/resilience-and-hooks.md).

## Bulk operations

`upload`, `download`, `head`, and `exists` take a single key **or an array**; `delete` takes one key or many. The array form fans out with bounded concurrency (8 by default) and returns a structured result that keeps successes and failures separate, in input order — **one bad key never sinks the batch, and it does not throw on partial failure**.

```ts
const { uploaded, errors } = await files.upload([
  { key: "a.txt", body: "alpha" },
  { key: "b.txt", body: "beta", contentType: "text/plain" },
]);

const { existing, missing } = await files.exists(["a.txt", "b.txt", "c.txt"]);
const { deleted } = await files.delete(["a.txt", "b.txt"], { concurrency: 16 });
```

Result shapes: `upload → { uploaded, errors? }`, `download → { downloaded, errors? }`, `head → { files, errors? }`, `exists → { existing, missing, errors? }`, `delete → { deleted, errors? }`. `errors` is `{ key, error }[]`, omitted entirely when everything succeeded. Pass `stopOnError: true` to bail at the first failure (runs sequentially). Bulk calls are not retried and fire one aggregated `onAction`.

## Large & resilient uploads

Three per-call `upload`/`download` options for big objects — all detailed in [references/large-uploads.md](references/large-uploads.md):

- **`multipart`** on `upload` — split a large body into parallel parts (`true`, or `{ partSize, concurrency }`). The robust path past the single-request limit and for `ReadableStream` bodies of unknown length (which **auto-engage** multipart on S3-family adapters even without the flag). Maps to each provider's native chunking; unsupported adapters that only take buffered bodies ignore it, except the `fetch` S3 engine, which throws.
- **`control`** on `upload` (resumable) — pass an `UploadControl` (exported from `files-sdk`) to `pause()`/`resume()`/`abort()`, and persist `control.toJSON()` to resume in a later process after a crash. Requires a **known-length** body (no bare `ReadableStream`). Supported on S3-family, GCS, Firebase, Azure, OneDrive, Dropbox, and more; unsupported adapters throw. Distinct from `multipart` (this drives the provider's resumable session and exposes the upload id).
- **`range`** on `download` — fetch a contiguous byte slice (`{ start, end? }`, 0-based, `end` inclusive — HTTP `Range` semantics, not `slice()`). The primitive behind video seeking and resuming. **Throws** on adapters with no range primitive (check `adapter.supportsRange`).
- **`onProgress`** on `upload` — `({ loaded, total? }) => void`. S3-family reports true byte-level progress (via the optional `@aws-sdk/lib-storage` peer dep).

## Bulk, move & transfer

- **`move(from, to)`** — rename within an adapter (native rename where the provider has one, else copy+delete; moving onto itself is a no-op). `FileHandle` has `moveTo`/`moveFrom`.
- **`listAll(opts?)`** — async iterable over every page; each page is a real `list` call so retries/timeouts/prefix all apply.
- **`transfer(source, dest, opts?)`** — top-level export. Streams every object from one `Files` instance to another across backends (the one thing the unified surface uniquely enables, since `copy`/`move` are single-adapter). Built on `listAll` + streaming `download` + `exists` + `upload`. Body, content type, and user metadata travel (metadata is dropped when the destination has no metadata support, rather than failing each key); `etag`/`lastModified` are destination-assigned and `Cache-Control` is **not** carried. Returns `{ transferred, skipped?, errors? }` (no throw on partial failure). A throwing `onProgress` is ignored. Options: `prefix`, `transformKey`, `overwrite`, `concurrency` (default 8), `limit`, `stopOnError`, `signal`, `onProgress`.
- **`sync(source, dest, opts?)`** — top-level export for repeatable mirrors: uploads only new or changed objects (`compare: "etag"` by default, or `"size"`, or a function) and, with `prune: true`, deletes destination keys the source no longer has (destructive). `dryRun: true` returns the plan without writing. Metadata and `onProgress` behave as in `transfer`. Returns `{ uploaded, skipped, deleted?, errors? }`.

```ts
import { Files, transfer } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { r2 } from "files-sdk/r2";

const from = new Files({ adapter: s3({ bucket: "old" }) });
const to = new Files({
  adapter: r2({ bucket: "new", accountId, accessKeyId, secretAccessKey }),
});
const { transferred, errors } = await transfer(from, to, {
  prefix: "uploads/",
});
```

See [references/bulk-and-transfer.md](references/bulk-and-transfer.md).

## Folder listing

`list({ delimiter: "/" })` collapses keys at the boundary into S3-style common prefixes — the building block for a file-browser UI. With `prefix: "photos/"`, `items` are the direct files and `ListResult.prefixes` holds the subfolders (`["photos/2023/", "photos/2024/"]`). Object stores and folder-based providers support it (folder-based ones only accept `"/"`); flat stores (UploadThing, Appwrite, PocketBase, Convex, Bunny Storage) **throw** — check `files.capabilities.delimiter`. A cursor is only valid for the exact `prefix` **and** `delimiter` it was produced with.

## URL behavior

`url(key, opts?)` returns the most direct URL the adapter can produce. Behavior is not uniform:

- **Signing adapters** (S3, R2 HTTP, MinIO, RustFS, DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi, Tigris): presigned `GetObject` URL expiring after `opts.expiresIn` seconds (default ~3600). If the adapter was constructed with `publicBaseUrl`, the URL is built against that origin instead and does not expire.
- **R2 binding**: uses `publicBaseUrl` if set; falls back to HTTP signing if HTTP credentials were also passed (hybrid); otherwise throws.
- **Vercel Blob (public)**: permanent CDN URL. `expiresIn` is ignored.
- **Vercel Blob (private)**: presigned `GET` scoped to that key, expiring after `expiresIn` (default 3600, or the adapter's `defaultUrlExpiresIn`; Vercel caps it at 7 days).
- **FTP / SFTP / WebDAV**: need `publicBaseUrl` (an HTTP server fronting the same tree); otherwise `url()` throws. `fs` returns a `file://` URL unless `urlBaseUrl` is set.

### Two `UrlOptions` worth knowing

- `expiresIn` — seconds. Honored by signing adapters (including Vercel Blob private); ignored by Vercel Blob public and `publicBaseUrl` URLs; N/A where `url()` throws.
- `responseContentDisposition` — **strongly recommend `"attachment"` (or `'attachment; filename="..."'`) for user-uploaded buckets.** Without it, a user-uploaded `.html` or scripted SVG executes inline at the bucket origin (stored XSS). Passing this option **forces the signing path** on signing adapters (even when `publicBaseUrl` is set) because a permanent CDN URL has no signature to bind the override to. Throws on Vercel Blob (no primitive) and R2 binding without HTTP creds.

### Key encoding

Pass **raw** keys. URLs built from `publicBaseUrl` / `urlBaseUrl` (and Vercel Blob's public fast path) percent-encode each key segment for you, and signing adapters encode through the provider's signer — so pre-encoding a key double-encodes it (`%20` → `%2520`) or, on a signing adapter, names a different object. If keys come from untrusted input, validate them (reject `..` segments, control characters, unexpected prefixes) rather than escaping them.

## Signed upload URLs

`signedUploadUrl(key, opts)` where `opts: { expiresIn, contentType?, maxSize?, minSize? }`.

- **Always pass `maxSize`.** Without it, the adapter returns a presigned `PUT` URL with **no server-side size limit** — anyone holding the URL can upload an arbitrarily large file until `expiresIn` elapses. With `maxSize`, supporting adapters return a presigned `POST` form (S3 and the S3-compatible adapters on the AWS SDK engine, GCS, Firebase) enforcing the size via a `content-length-range` policy; Vercel Blob enforces it on its presigned `PUT`. Adapters that can't enforce it (R2, Azure, Supabase, the `fetch` S3 engine, …) fail closed.
- `minSize` defaults to `1` (rejects empty uploads, which are usually a broken client). Pass `0` to allow zero-byte uploads. Providers with no minimum-size constraint (Cloudinary, UploadThing, Vercel Blob, Azure, Supabase) throw on an explicit positive `minSize` — omit it or pass `0`.
- `contentType` is bound into the signature where the provider supports it; adapters that can't enforce it (bun-s3, Azure, Supabase, Cloudinary, OneDrive, SharePoint) throw rather than returning an advisory header.
- `expiresIn` is capped where the provider caps it: the S3 family (including bun-s3 and the fetch engine) throws past SigV4's 7 days rather than returning a URL that is dead on arrival, and GCS/Firebase V4 signing rejects past 7 days too. `files.capabilities.signedUrl.maxExpiresIn` reports the cap (`604800` on those, and on UploadThing's private mode), and the gateway clamps requested expiries to it.
- Return shape is one of:
  - `{ method: "PUT", url, headers? }`
  - `{ method: "POST", url, fields }` — POST as `multipart/form-data` with `fields` and the file **last**.

See [references/client-uploads.md](references/client-uploads.md).

## Errors

Every adapter error is wrapped in `FilesError` (re-exported from `files-sdk`). It has:

- `.code` of type `FilesErrorCode`: `"NotFound" | "Unauthorized" | "Conflict" | "ReadOnly" | "Provider"`.
- `.aborted` — `true` when the failure came from a [cancellation or timeout](#instance-options) (still `code: "Provider"`); this flag, not the code, is how you tell an abort from a real provider failure.
- `.cause` — the underlying provider error (may carry request IDs/headers; don't blindly `JSON.stringify` it across a trust boundary).
- `.permanent` — `true` for deterministic SDK-side rejections (an option the adapter can't honor, a fail-closed plugin). Still `code: "Provider"`, but never retried, and the `failover` plugin doesn't fail over on them.

Catch `FilesError` at the boundary; branch on `.code`. Only non-permanent `Provider` failures are retried. See [references/errors-and-recipes.md](references/errors-and-recipes.md).

## Escape hatch

```ts
import type { s3 } from "files-sdk/s3";
const native = files.raw; // typed as the native client for the configured adapter
```

Use this for provider features that aren't in the unified API (versioning, lifecycle, storage classes, etc.). `files.adapter` exposes the `Adapter` (e.g. `files.adapter.bucket`). Note: `raw` bypasses a `readonly` instance by design.

## Adapter catalog

48 adapters. S3-family and S3-compatible stores wrap the `s3()` adapter with provider-friendly defaults (MinIO, RustFS, DigitalOcean Spaces, Wasabi, Backblaze B2, Tigris, Storj, Hetzner, Scaleway, OVH, Vultr, IBM COS, Oracle, Tencent, Alibaba, Yandex, …). Direct-binding adapters (R2 worker binding, fs, Vercel Blob, Netlify Blobs, GCS, Azure, Supabase, Dropbox, Google Drive, OneDrive, Box, SharePoint, Cloudinary, UploadThing, Appwrite, Convex, Firebase Storage, PocketBase, FTP, SFTP, WebDAV, Bunny Storage, bun-s3, …) have their own implementation. There's also an in-memory adapter at **`files-sdk/memory`** — full `Adapter` contract backed by a `Map`, zero deps, isomorphic — for testing code that uses `Files` without touching real storage (`url()` returns an opaque `memory://` URL; not for production).

Always check the live list and per-adapter options at <https://files-sdk.dev> (or the bundled `docs/adapters/`) rather than guessing. The `exports` map in `node_modules/files-sdk/package.json` is authoritative for what subpaths exist, and `files-sdk/providers` exports the same catalog as data (`PROVIDERS`, `getProvider(slug)`, each adapter's env vars and required config).

S3-compatible wrappers need the `@aws-sdk/*` peers. On Cloudflare Workers (or anywhere you want no AWS SDK), use `files-sdk/s3-fetch` (`s3Fetch()`, a SigV4 `fetch` engine) or `client: "fetch"` on `r2()` / `minio()` / `rustfs()` — `r2` picks it automatically inside Workers. The fetch engine has no multipart/resumable uploads.

## Plugins

`plugins: [...]` wraps every call on the instance (`plugins[0]` is outermost). Each plugin is its own subpath:

| Subpath | Factory | What it does |
| --- | --- | --- |
| `files-sdk/validation` | `validation()` | Fail-closed write guard: size, MIME type, key rules. |
| `files-sdk/content-type` | `contentType()` | Sniffs magic bytes to set or verify `Content-Type`. |
| `files-sdk/encryption` | `encryption()` | Client-side envelope AES-256-GCM (`generateEncryptionKey()`). |
| `files-sdk/compression` | `compression()` | gzip/deflate bodies at rest. |
| `files-sdk/dedup` | `dedup()` | Content-addressed storage; identical bodies stored once. |
| `files-sdk/versioning` | `versioning()` | Snapshot on overwrite/delete; `files.versions()` / `restoreVersion()`. |
| `files-sdk/soft-delete` | `softDelete()` | Recycle bin; `trashed()` / `restoreTrashed()` / `purge()`. |
| `files-sdk/cache` | `cache()` | LRU/KV cache for `head()` / `url()` / small downloads. |
| `files-sdk/tiering` | `tiering()` | Route hot/cold objects across two backends. |
| `files-sdk/failover` | `failover()` | Retry provider failures against replica backends. |
| `files-sdk/signed-url-policy` | `signedUrlPolicy()` | Force `attachment` disposition on `url()` and cap signed-URL lifetimes. |
| `files-sdk/audit` | `audit()` | Awaited who/what/when log of mutations. |
| `files-sdk/usage` | `usage()` | Meter ops and bytes; `files.usage()`. |
| `files-sdk/tracing` | `tracing()` | OpenTelemetry span per operation. |
| `files-sdk/zip` | `zip()` | Stream objects as a ZIP archive and extract archives into keys. |

```ts
import { createFiles } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { validation } from "files-sdk/validation";
import { versioning } from "files-sdk/versioning";

const files = createFiles({
  adapter: s3({ bucket: "uploads" }),
  plugins: [validation({ maxSize: 10 * 1024 * 1024 }), versioning()],
});
await files.versions("report.pdf"); // typed because createFiles was used
```

Use `createFiles` (not `new Files`) when a plugin adds methods, so they show up on the type. Order matters. `contentType()` goes before `validation()`, so the check sees the sniffed type rather than the claimed one. `validation()` goes before `versioning()`, `softDelete()`, and `dedup()`: their internal keys (snapshots, trash, blobs) only pass through plugins placed after them, so a `validation()` further in would reject them. `encryption()` goes after anything that must see plaintext (`[compression(), encryption(key)]`), but before `failover()` and `tiering()` (`[encryption(key), tiering(...)]`): they drive their secondary / cold backend outside the rest of the onion, so placed ahead of `encryption()` whatever they route there is stored unencrypted. Read each plugin's page under the bundled `docs/plugins/` (or <https://files-sdk.dev/docs/plugins>) before composing others.

Body-transforming plugins fail closed rather than hand out something that bypasses them: `encryption()` and `compression()` throw on `url()`, `signedUploadUrl()`, range reads, and resumable `control` uploads (and report `multipart: false`); `dedup()` throws on `url()`, `signedUploadUrl()`, and conditional operations. These refusals, like `validation()` and `contentType()` rejections, are `permanent`, so `failover()` never re-sends them to a replica that runs without the plugin. A plugin can declare what it refuses through the `FilesPlugin.capabilities?(caps)` hook, which narrows `files.capabilities`, so callers and the gateway see it up front (for example, the gateway proxies downloads instead of redirecting to a signed URL; `versioning()`, `softDelete()`, `tiering()`, and `failover()` switch off the `conditional` flags for the compare-and-set operations they refuse). On adapters whose `list()` carries no object metadata (S3 and the S3-compatibles), `list()` items under `encryption()`, `compression()`, or `dedup()` report the stored object's size (for `dedup()`, the empty pointer's), though their body accessors still return the decoded content.

## Browser uploads & the gateway (`useFiles`)

To give a browser the whole `Files` API without shipping credentials, mount a gateway on your server and call it from a client binding:

- **Server:** `createFilesRouter({ files, authorize, allowedOrigins })` from `files-sdk/api`, mounted with a framework adapter's `createRouteHandler` — `files-sdk/next`, `hono`, `express`, `fastify`, `koa`, `nitro`, `astro`, `sveltekit`, `tanstack-start` (and `FilesModule` from `files-sdk/nestjs`). The gateway is **deny-by-default**: with no `authorize` hook and no `operations` allow-list, every verb but `capabilities` returns 403. `authorize` throws to deny or returns a constraint, typically a per-user `keyPrefix` such as `"users/<id>/"`.
  - `defaultExpiresIn` is only the default URL lifetime, not a ceiling: cap client-requested expiries with `maxExpiresIn` from `authorize`.
  - The gateway bounds client-driven load: `maxBatchSize` (array lengths, default 1000, 413), `maxConcurrency` (default 16), `maxJsonBodySize` (default 1 MiB, 413), search pages clamped to `maxListLimit`, and `search` patterns limited by `maxSearchPatternLength` (256) / `maxSearchWildcards` (4) (422); a `match: "regex"` pattern that doesn't compile or could backtrack catastrophically is also a 422.
- **Client:** `useFiles({ endpoint: "/api/files" })` from `files-sdk/react`, `files-sdk/vue`, or `files-sdk/svelte` (every verb, upload progress, plus reactive `useList` / `useFile` / `useSearch`); `createFilesClient` from `files-sdk/client` for non-framework callers. `uploads` accumulates one `FileUploadState` per file across calls (single and bulk) until `reset()` clears the finished ones; every state ends `success`, `error` (with `error` set), or `aborted`. Errors from every verb, including `listAll` / `search` iteration, are mirrored into `error`.

See the bundled `docs/ui/` (or <https://files-sdk.dev/docs/ui>) for per-framework setup, authorization, and the shadcn component registry.

## CLI & MCP server

`files-sdk` ships a **`files` CLI** (the `files` bin) at full parity with the SDK. Install globally or run via `npx -p files-sdk files …`. Pick a provider with `--provider <name>` (or `FILES_SDK_PROVIDER`); credentials come from the adapter's standard env vars. Output is JSON by default; bodies stream over stdin/stdout.

```sh
files --provider s3 --bucket uploads upload reports/q1.pdf --file ./q1.pdf
files --provider s3 --bucket uploads list --prefix reports/ --all | jq '.items[].key'
files --provider s3 --bucket old transfer --to '{"provider":"r2","bucket":"new",...}' --prefix uploads/
```

Commands: `upload download head exists list search copy move delete url sign-upload capabilities transfer sync mcp`. Global flags mirror the constructor: `--key-prefix` (instance prefix, distinct from `list --prefix`), `--timeout`, `--retries`. `head`/`exists`/`delete` take multiple keys + `--concurrency`/`--stop-on-error`; `download --range`, `upload --multipart`/`--part-size`, `list --all`, `upload --dir`/`download --out-dir`.

The built-in **MCP server** (`files … mcp`) is **read-only by default** — exposes `download`, `head`, `exists`, `list`, `search`, `url`, `capabilities`. Pass **`--allow-writes`** to also expose `upload`, `delete`, `copy`, `move`, `sign-upload`; `transfer` and `sync` additionally need an operator-fixed destination via `mcp --allow-writes --to '<json>'` (the agent never picks the destination). Provider + credentials are bound at startup; the agent only passes operation arguments, never secrets. Binary payloads roundtrip as base64.

See [references/cli-and-mcp.md](references/cli-and-mcp.md). (This MCP server is the CLI-level binding — distinct from the in-process AI-tool bindings below.)

## AI tools

Three subpaths expose a configured `Files` instance as in-process tools for AI agents. All share the same eight operations (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) and the same approval-gating defaults (the four writes are gated; reads are not). `downloadFile` takes a `maxBytes` guard so a model can't pull an unbounded object into context.

| Subpath | For | Factory |
| --- | --- | --- |
| `files-sdk/ai-sdk` | Vercel AI SDK (`generateText`, `streamText`, `ToolLoopAgent`) | `createFileTools` |
| `files-sdk/openai` | OpenAI Responses API and Agents SDK | `createResponsesFileTools` / `createAgentsFileTools` |
| `files-sdk/claude` | Anthropic Claude Agent SDK | `createClaudeFileTools` |

```ts
import { Files } from "files-sdk";
import { createFileTools } from "files-sdk/ai-sdk";
import { s3 } from "files-sdk/s3";
import { generateText } from "ai";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

await generateText({
  model,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});
```

Key options on `createFileTools` (mirrored across the three):

- `readOnly: true` — strips write tools entirely (`uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`). The model cannot mutate the bucket. (For a non-AI lock, see the SDK-level `readonly` in [Instance options](#instance-options).)
- `requireApproval` — defaults to `true` (all writes require approval). Pass `false`, or a per-tool record like `{ deleteFile: true, uploadFile: false }`.
- `overrides` — per-tool patches for `description`, `title`, `needsApproval`. Cannot override `execute`, `inputSchema`, or `outputSchema`.

See [references/ai-tools.md](references/ai-tools.md).

## Decision guide

- **"How do I add file uploads to my app?"** → Pick the adapter that matches their hosting/provider, show `new Files({ adapter: x({...}) })` + `upload`/`url`.
- **Swap providers** → Change the subpath import and the adapter factory call; the rest of the code is unchanged.
- **Presigned client-side uploads** → `signedUploadUrl` with `maxSize` (always). Walk them through the `PUT` vs `POST` return shape.
- **Public download URL** → `files.url(key)`; recommend `responseContentDisposition: "attachment"` for user content. If their adapter throws on `url()` (R2 binding w/o config, FTP/SFTP/WebDAV without `publicBaseUrl`, Netlify Blobs, Google Drive/OneDrive/SharePoint without `publicByDefault`), use `download()` or configure `publicBaseUrl`/HTTP creds.
- **Large file / unreliable connection** → `multipart` for big bodies and unknown-length streams; resumable `control` (`UploadControl`) to pause/resume or survive a crash; `download({ range })` for seeking/resuming.
- **Many keys at once** → the bulk array form (`upload([...])`, `delete([...])`, …) with `concurrency`/`stopOnError`; inspect `result.errors`.
- **Migrate a bucket to another provider** → top-level `transfer(from, to, { prefix })`. **Keep a backup mirror current** → `sync(from, to, { prune })`.
- **Find files by name/pattern** → `files.search("reports/**/*.pdf")`.
- **Create-only or compare-and-set writes** → `upload(..., { condition })`.
- **Validate, encrypt, version, cache, or trace storage** → the matching [plugin](#plugins).
- **Upload from the browser** → presigned `signedUploadUrl` for a single upload form; the gateway + `useFiles` for a full browser file manager.
- **Rename a key** → `move`. **Walk a whole bucket** → `listAll`. **File-browser folders** → `list({ delimiter: "/" })`.
- **Multi-tenant / namespaced keys** → `new Files({ prefix })`.
- **Lock storage to reads** → SDK-level `new Files({ readonly: true })` / `files.readonly()`.
- **Audit log / metrics / activity feed** → `hooks` (`onAction`/`onError`/`onRetry`).
- **Shell scripts / CI / a quick poke at a bucket** → the `files` CLI. **Give an MCP client (Claude Code, etc.) bucket access** → `files … mcp` (read-only; add `--allow-writes` deliberately).
- **Give an in-app LLM bucket access** → the matching AI-tools subpath. Default to leaving `requireApproval` on for writes; suggest `readOnly: true` if it only needs to read.
- **Test code that uses `Files`** → swap in `files-sdk/memory`.
- **Feature not in the unified API** → `files.raw` + the provider's native client.

## References

Load the relevant reference file only when the user's task matches it — don't preload them all.

When the package is installed locally, `node_modules/files-sdk/docs` holds the full, version-matched documentation (see the note at the top) — reach for it for per-adapter detail the bundled references below don't cover.

- [references/adapter-setup.md](references/adapter-setup.md) — construction snippets and non-obvious knobs for the common adapters (`s3`, `r2` HTTP vs binding vs hybrid, `vercel-blob` public vs private, `gcs`, `azure`, `minio`, `fs`).
- [references/client-uploads.md](references/client-uploads.md) — presigned-upload flow end-to-end: server route returning `signedUploadUrl` with `maxSize`, client handling for PUT and POST, the field-order gotcha on POST, server-side confirmation.
- [references/large-uploads.md](references/large-uploads.md) — multipart, resumable (`UploadControl`, cross-process resume), range downloads, and `onProgress`: when each applies, per-adapter support, and the gotchas (known-length bodies, throw-on-unsupported, auto-multipart for streams).
- [references/bulk-and-transfer.md](references/bulk-and-transfer.md) — bulk array forms and their result shapes, `listAll`, `move`, cross-provider `transfer`, `sync` mirrors, and folder listing with `delimiter`.
- [references/resilience-and-hooks.md](references/resilience-and-hooks.md) — `retries`, `timeout`, cancellation (`signal`), `prefix` scoping, `readonly` views, and the `onAction`/`onError`/`onRetry` hooks.
- [references/cli-and-mcp.md](references/cli-and-mcp.md) — the `files` CLI commands (incl. `search`, `sync`, `capabilities`), global flags, JSON/stream output, and wiring the built-in MCP server (read-only vs `--allow-writes`, `--to` for transfer/sync) into an MCP client.
- [references/ai-tools.md](references/ai-tools.md) — full examples for `files-sdk/ai-sdk`, `files-sdk/openai` (Responses + Agents), and `files-sdk/claude`. Covers `readOnly`, granular approval, per-tool overrides, the `maxBytes` download guard, and how to choose across the three.
- [references/errors-and-recipes.md](references/errors-and-recipes.md) — `FilesError.code` values (incl. `ReadOnly`) and the `aborted` flag, the `exists()`/`head()` traps, key-encoding rules, and migration rewrites from `@aws-sdk/client-s3`, `@vercel/blob`, and `@google-cloud/storage`.

## Verification

Before answering with specifics:

- Confirm the adapter the user has chosen actually exists by checking the `exports` in `node_modules/files-sdk/package.json` (or `PROVIDER_NAMES` from `files-sdk/providers`).
- For non-obvious behavior (URL signing, `exists` semantics, `signedUploadUrl` POST vs PUT, which adapters support `range`/`delimiter`/resumable `control`), re-read the JSDoc in `node_modules/files-sdk/dist/index.d.ts` (and `dist/<adapter>/index.d.ts`) or the bundled `docs/` rather than trusting memory — or check `files.capabilities` at runtime.
