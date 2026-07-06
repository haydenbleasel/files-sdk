---
name: files-sdk
description: Use files-sdk to add file storage to a TypeScript/JavaScript app with a unified API across S3, R2, GCS, Azure, Vercel Blob, the local filesystem, and 40+ other providers. Triggers when the user wants to upload/download/list/move/delete/copy files, generate presigned URLs, do multipart or resumable uploads, range downloads, bulk (array) operations, migrate between providers, list folders, scope to a prefix, observe activity with hooks, use the `files` CLI or its MCP server, expose storage to an AI agent (Vercel AI SDK, OpenAI Responses/Agents, Claude Agent SDK), or asks about "files-sdk", "Files SDK", `new Files(...)`, `files.upload`, `files.move`, `files.url`, `files.signedUploadUrl`, `transfer(...)`, `UploadControl`, or any `files-sdk/<adapter>` subpath import.
---

# files-sdk

A unified storage SDK for object and blob backends. One small API. Web-standard I/O. Escape hatch to the native client when needed.

When the user asks for help integrating it, follow this skill. It is the source of truth — prefer it over training-data memory of the package.

> **Bundled docs:** When `files-sdk` is installed, the full documentation ships inside the package at `node_modules/files-sdk/docs`. Read those MDX files for the complete, version-matched reference: per-adapter setup under `docs/adapters/`, AI tools under `docs/ai/`, the CLI under `docs/cli/`, per-feature pages under `docs/features/`, plus `overview`, `api/*`, `providers`, and `troubleshooting`. Prefer them over <https://files-sdk.dev> when the package is present locally — they match the installed version exactly.

## Mental model

- One core class `Files`, configured once with an adapter at construction time. The adapter is fixed for the life of the instance.
- 40+ adapters, each a separate subpath export so only what you import is bundled (`files-sdk/s3`, `files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, `files-sdk/vercel-blob`, `files-sdk/fs`, …).
- The unified API is the **common subset** of what every adapter can do. Provider-specific features (S3 versioning, lifecycle, storage classes, etc.) live behind `files.raw`, which returns the underlying native client.
- Bodies are web-standard: `Blob`, `File`, `ReadableStream<Uint8Array>`, `Uint8Array`, `ArrayBuffer`, `ArrayBufferView`, or `string`. No provider types leak.
- Every method takes the same `OperationOptions` (`signal`, `timeout`, `retries`), and most of those can also be set once on the constructor as instance defaults. The constructor additionally takes `prefix`, `readonly`, and `hooks`.
- Where an adapter can't do something the unified surface offers (a range download, a folder listing, a resumable session), it **throws a `FilesError` rather than silently degrading** — so a missed capability is loud, not a quiet correctness bug. Capability flags (`supportsRange`, `supportsDelimiter`) let you branch at runtime.

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
| `upload(key, body, opts?)` | `UploadResult` | `opts`: `contentType`, `cacheControl`, `metadata`, `onProgress`, `multipart`, `control`. Array form → `{ uploaded, errors? }`. |
| `download(key, opts?)` | `StoredFile` | `opts.as` is `"blob"` or `"stream"`; `opts.range` for a byte slice. Array form → `{ downloaded, errors? }`. |
| `head(key, opts?)` | `StoredFile` | Metadata only. The returned object still has `text()`/`blob()`/`arrayBuffer()`/`stream()` but they lazy-GET. Array form → `{ files, errors? }`. |
| `exists(key, opts?)` | `boolean` | `false` only on `NotFound`. Auth/transport errors still throw. Array form → `{ existing, missing, errors? }`. |
| `delete(key, opts?)` | `void` | Array form → `{ deleted, errors? }` (uses native batch delete on S3/Supabase/UploadThing). |
| `copy(from, to, opts?)` | `void` | Within one adapter. |
| `move(from, to, opts?)` | `void` | Rename. Native rename where available (`fs`, Cloudinary), else copy+delete. Throws on immutable stores (Convex). |
| `list(opts?)` | `{ items, prefixes?, cursor? }` | `opts`: `prefix`, `cursor`, `limit`, `delimiter`. `delimiter` returns folder `prefixes` — see [Folder listing](#folder-listing). |
| `listAll(opts?)` | `AsyncGenerator<StoredFile>` | Walks every page for you, following the cursor. `for await (const f of files.listAll({ prefix }))`. |
| `url(key, opts?)` | `string` | See [URL behavior](#url-behavior) — varies by adapter. |
| `signedUploadUrl(key, opts)` | `SignedUpload` | See [Signed upload URLs](#signed-upload-urls) — pass `maxSize`. |
| `file(key)` | `FileHandle` | Same single-key methods, key pre-bound. Also `copyTo`/`copyFrom`/`moveTo`/`moveFrom`. |
| `raw` / `adapter` (getters) | native client / `Adapter` | Escape hatch — see [Escape hatch](#escape-hatch). |
| `readonly()` (method) | `Files` | A read-only view reusing the same adapter/prefix/hooks — see [Instance options](#instance-options). |

Plus a top-level `transfer(source, dest, opts?)` for cross-provider migration — see [Bulk, move & transfer](#bulk-move--transfer).

### `StoredFile` shape

`name`, `key`, `size`, `type`, `lastModified?`, `etag?`, `metadata?`, plus `arrayBuffer()`, `text()`, `blob()`, `stream()`.

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
- **`readonly: true`** — blocks every write surface (`upload`, `delete`, `copy`, `move`, `signedUploadUrl`, and the `file(key)` write helpers) with `FilesError { code: "ReadOnly" }`. Reads still work. `files.readonly()` derives such a view from an existing instance (same adapter/prefix/timeout/retries/hooks, no second client). Does **not** lock down `files.raw`.
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

- **`multipart`** on `upload` — split a large body into parallel parts (`true`, or `{ partSize, concurrency }`). The robust path past the single-request limit and for `ReadableStream` bodies of unknown length (which **auto-engage** multipart on S3-family adapters even without the flag). Maps to each provider's native chunking; unsupported adapters that only take buffered bodies ignore it.
- **`control`** on `upload` (resumable) — pass an `UploadControl` (exported from `files-sdk`) to `pause()`/`resume()`/`abort()`, and persist `control.toJSON()` to resume in a later process after a crash. Requires a **known-length** body (no bare `ReadableStream`). Supported on S3-family, GCS, Firebase, Azure, OneDrive, Dropbox, and more; unsupported adapters throw. Distinct from `multipart` (this drives the provider's resumable session and exposes the upload id).
- **`range`** on `download` — fetch a contiguous byte slice (`{ start, end? }`, 0-based, `end` inclusive — HTTP `Range` semantics, not `slice()`). The primitive behind video seeking and resuming. **Throws** on adapters with no range primitive (check `adapter.supportsRange`).
- **`onProgress`** on `upload` — `({ loaded, total? }) => void`. S3-family reports true byte-level progress (via the optional `@aws-sdk/lib-storage` peer dep).

## Bulk, move & transfer

- **`move(from, to)`** — rename within an adapter (native rename where the provider has one, else copy+delete; moving onto itself is a no-op). `FileHandle` has `moveTo`/`moveFrom`.
- **`listAll(opts?)`** — async iterable over every page; each page is a real `list` call so retries/timeouts/prefix all apply.
- **`transfer(source, dest, opts?)`** — top-level export. Streams every object from one `Files` instance to another across backends (the one thing the unified surface uniquely enables, since `copy`/`move` are single-adapter). Built on `listAll` + streaming `download` + `exists` + `upload`. Body, content type, and user metadata travel; `etag`/`lastModified` are destination-assigned and `Cache-Control` is **not** carried. Returns `{ transferred, skipped?, errors? }` (no throw on partial failure). Options: `prefix`, `transformKey`, `overwrite`, `concurrency` (default 8), `limit`, `stopOnError`, `signal`, `onProgress`.

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

`list({ delimiter: "/" })` collapses keys at the boundary into S3-style common prefixes — the building block for a file-browser UI. With `prefix: "photos/"`, `items` are the direct files and `ListResult.prefixes` holds the subfolders (`["photos/2023/", "photos/2024/"]`). Object stores and folder-based providers support it (folder-based ones only accept `"/"`); flat stores (UploadThing, Appwrite, PocketBase, Convex, bun-s3) **throw** — check `adapter.supportsDelimiter`. A cursor is only valid for the exact `prefix` **and** `delimiter` it was produced with.

## URL behavior

`url(key, opts?)` returns the most direct URL the adapter can produce. Behavior is not uniform:

- **Signing adapters** (S3, R2 HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi, Tigris): presigned `GetObject` URL expiring after `opts.expiresIn` seconds (default ~3600). If the adapter was constructed with `publicBaseUrl`, the URL is built against that origin instead and does not expire.
- **R2 binding**: uses `publicBaseUrl` if set; falls back to HTTP signing if HTTP credentials were also passed (hybrid); otherwise throws.
- **Vercel Blob (public)**: permanent CDN URL. `expiresIn` is ignored.
- **Vercel Blob (private)**: throws — no URL primitive. Use `download()`.

### Two `UrlOptions` worth knowing

- `expiresIn` — seconds. Honored by signing adapters; ignored by Vercel Blob public; N/A where `url()` throws.
- `responseContentDisposition` — **strongly recommend `"attachment"` (or `'attachment; filename="..."'`) for user-uploaded buckets.** Without it, a user-uploaded `.html` or scripted SVG executes inline at the bucket origin (stored XSS). Passing this option **forces the signing path** on signing adapters (even when `publicBaseUrl` is set) because a permanent CDN URL has no signature to bind the override to. Throws on Vercel Blob (no primitive) and R2 binding without HTTP creds.

### Key encoding

The SDK does **not** URL-encode keys when building public URLs (or Vercel Blob's fast path). The caller is responsible. If keys come from untrusted input, validate or `encodeURIComponent`-escape segments before passing.

## Signed upload URLs

`signedUploadUrl(key, opts)` where `opts: { expiresIn, contentType?, maxSize?, minSize? }`.

- **Always pass `maxSize`.** Without it, the adapter returns a presigned `PUT` URL with **no server-side size limit** — anyone holding the URL can upload an arbitrarily large file until `expiresIn` elapses. With `maxSize`, supporting adapters return a presigned `POST` form (S3/R2) enforcing the size via a `content-length-range` policy. Adapters that can't enforce it fail closed.
- `minSize` defaults to `1` (rejects empty uploads, which are usually a broken client). Pass `0` to allow zero-byte uploads.
- `contentType` is bound into the signature where the provider supports it; adapters that can't enforce it throw rather than returning an advisory header.
- Return shape is one of:
  - `{ method: "PUT", url, headers? }`
  - `{ method: "POST", url, fields }` — POST as `multipart/form-data` with `fields` and the file **last**.

See [references/client-uploads.md](references/client-uploads.md).

## Errors

Every adapter error is wrapped in `FilesError` (re-exported from `files-sdk`). It has:

- `.code` of type `FilesErrorCode`: `"NotFound" | "Unauthorized" | "Conflict" | "ReadOnly" | "Provider"`.
- `.aborted` — `true` when the failure came from a [cancellation or timeout](#instance-options) (still `code: "Provider"`); this flag, not the code, is how you tell an abort from a real provider failure.
- `.cause` — the underlying provider error (may carry request IDs/headers; don't blindly `JSON.stringify` it across a trust boundary).

Catch `FilesError` at the boundary; branch on `.code`. Only `Provider` failures are retried. See [references/errors-and-recipes.md](references/errors-and-recipes.md).

## Escape hatch

```ts
import type { s3 } from "files-sdk/s3";
const native = files.raw; // typed as the native client for the configured adapter
```

Use this for provider features that aren't in the unified API (versioning, lifecycle, storage classes, etc.). `files.adapter` exposes the `Adapter` (e.g. `files.adapter.bucket`). Note: `raw` bypasses a `readonly` instance by design.

## Adapter catalog

40+ adapters. S3-family and S3-compatible stores wrap the `s3()` adapter with provider-friendly defaults (MinIO, DigitalOcean Spaces, Wasabi, Backblaze B2, Tigris, Storj, Hetzner, Scaleway, OVH, Vultr, IBM COS, Oracle, Tencent, Alibaba, Yandex, …). Direct-binding adapters (R2 worker binding, fs, Vercel Blob, Netlify Blobs, GCS, Azure, Supabase, Dropbox, Google Drive, OneDrive, Box, SharePoint, Cloudinary, UploadThing, Appwrite, Convex, Firebase Storage, PocketBase, FTP, SFTP, …) have their own implementation. There's also an in-memory adapter at **`files-sdk/memory`** — full `Adapter` contract backed by a `Map`, zero deps, isomorphic — for testing code that uses `Files` without touching real storage (`url()` returns an opaque `memory://` URL; not for production).

Always check the live list and per-adapter options at <https://files-sdk.dev> (or the bundled `docs/adapters/`) rather than guessing. The `exports` map in `packages/files-sdk/package.json` is authoritative for what subpaths exist.

## CLI & MCP server

`files-sdk` ships a **`files` CLI** (the `files` bin) at full parity with the SDK. Install globally or run via `npx -p files-sdk files …`. Pick a provider with `--provider <name>` (or `FILES_SDK_PROVIDER`); credentials come from the adapter's standard env vars. Output is JSON by default; bodies stream over stdin/stdout.

```sh
files --provider s3 --bucket uploads upload reports/q1.pdf --file ./q1.pdf
files --provider s3 --bucket uploads list --prefix reports/ --all | jq '.items[].key'
files --provider s3 --bucket old transfer --to '{"provider":"r2","bucket":"new",...}' --prefix uploads/
```

Commands: `upload download head exists list copy move delete url sign-upload transfer`. Global flags mirror the constructor: `--key-prefix` (instance prefix, distinct from `list --prefix`), `--timeout`, `--retries`. `head`/`exists`/`delete` take multiple keys + `--concurrency`/`--stop-on-error`; `download --range`, `upload --multipart`/`--part-size`, `list --all`, `upload --dir`/`download --out-dir`.

The built-in **MCP server** (`files … mcp`) is **read-only by default** — exposes `download`, `head`, `exists`, `list`, `url`. Pass **`--allow-writes`** to also expose `upload`, `delete`, `copy`, `move`, `sign-upload`, `transfer`. Provider + credentials are bound at startup; the agent only passes operation arguments, never secrets. Binary payloads roundtrip as base64.

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
- **Public download URL** → `files.url(key)`; recommend `responseContentDisposition: "attachment"` for user content. If their adapter throws on `url()` (Vercel Blob private, R2 binding w/o config), use `download()` or configure `publicBaseUrl`/HTTP creds.
- **Large file / unreliable connection** → `multipart` for big bodies and unknown-length streams; resumable `control` (`UploadControl`) to pause/resume or survive a crash; `download({ range })` for seeking/resuming.
- **Many keys at once** → the bulk array form (`upload([...])`, `delete([...])`, …) with `concurrency`/`stopOnError`; inspect `result.errors`.
- **Migrate a bucket to another provider** → top-level `transfer(from, to, { prefix })`.
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
- [references/bulk-and-transfer.md](references/bulk-and-transfer.md) — bulk array forms and their result shapes, `listAll`, `move`, cross-provider `transfer`, and folder listing with `delimiter`.
- [references/resilience-and-hooks.md](references/resilience-and-hooks.md) — `retries`, `timeout`, cancellation (`signal`), `prefix` scoping, `readonly` views, and the `onAction`/`onError`/`onRetry` hooks.
- [references/cli-and-mcp.md](references/cli-and-mcp.md) — the `files` CLI commands, global flags, JSON/stream output, and wiring the built-in MCP server (read-only vs `--allow-writes`) into an MCP client.
- [references/ai-tools.md](references/ai-tools.md) — full examples for `files-sdk/ai-sdk`, `files-sdk/openai` (Responses + Agents), and `files-sdk/claude`. Covers `readOnly`, granular approval, per-tool overrides, the `maxBytes` download guard, and how to choose across the three.
- [references/errors-and-recipes.md](references/errors-and-recipes.md) — `FilesError.code` values (incl. `ReadOnly`) and the `aborted` flag, the `exists()`/`head()` traps, key-encoding rules, and migration rewrites from `@aws-sdk/client-s3`, `@vercel/blob`, and `@google-cloud/storage`.

## Verification

Before answering with specifics:

- Confirm the adapter the user has chosen actually exists by checking `packages/files-sdk/package.json` exports or `packages/files-sdk/src/<adapter>/`.
- For non-obvious behavior (URL signing, `exists` semantics, `signedUploadUrl` POST vs PUT, which adapters support `range`/`delimiter`/resumable `control`), re-read the JSDoc on the relevant interface/method in `packages/files-sdk/src/index.ts` rather than trusting memory — the capability matrices there are the source of truth.
