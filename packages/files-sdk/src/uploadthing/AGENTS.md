# AGENTS.md — `files-sdk/uploadthing`

Guidance for coding agents working on the `uploadthing` adapter
([UploadThing](https://uploadthing.com), exposed at the
`files-sdk/uploadthing` subpath). The unified `Adapter<Raw>` contract
— call shapes, `FilesError`, `UrlOptions`, `SignUploadOptions`, body
normalization — lives in [`../index.ts`](../index.ts); read it first.
This file documents only uploadthing-specific behavior.
Cross-references: [`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

This is a **native** adapter — no inner `s3()` shim. Every operation is
implemented against [`uploadthing/server`](https://docs.uploadthing.com)
(`UTApi`, `UTFile`) plus `fetch` for reads where UploadThing has no
metadata or body API. The adapter decodes `UPLOADTHING_TOKEN` at
construction (base64 JSON of `{ apiKey, appId, regions? }`) so
`url()` can synthesize the public CDN host (`https://{appId}.ufs.sh/f/…`)
and `signedUploadUrl()` can HMAC-sign UFS ingest PUT URLs without an API
round trip.

The central identity model: **your key is UploadThing's `customId`.**
`UTApi` is constructed with `defaultKeyType: "customId"`, so
`deleteFiles`, `generateSignedURL`, and uploads route by the caller's
key. UploadThing still assigns an opaque internal `fileKey` per object;
you normally never see it. Files uploaded out-of-band without a
`customId` surface their internal key on `list()` — treat that as
legacy/orphan data, not the adapter's contract.

`uploadthing(opts)` returns `Adapter<UTApi>`. `raw` is the `UTApi`
instance (`files.raw.uploadFiles`, `files.raw.listFiles`, …).

Peer dep: [`uploadthing`](https://www.npmjs.com/package/uploadthing),
pinned at `^7` in [`../../package.json`](../../package.json). Shared
plumbing: [`../internal/core.ts`](../internal/core.ts)
(`deleteManyWithFallback`, `existsByProbe`, `DEFAULT_URL_EXPIRES_IN`),
[`../internal/stored-file.ts`](../internal/stored-file.ts),
[`../internal/errors.ts`](../internal/errors.ts),
[`../internal/env.ts`](../internal/env.ts).

## Directory layout

```text
packages/files-sdk/src/uploadthing/
├── index.ts          # uploadthing() factory + UploadThingAdapterOptions
├── AGENTS.md         # this file
└── CLAUDE.md         # `@AGENTS.md` — Claude-Code re-export
```

Sibling files: tests at
[`../../test/uploadthing.test.ts`](../../test/uploadthing.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/uploadthing.mdx`](../../../../apps/web/content/docs/adapters/uploadthing.mdx);
subpath export at `exports["./uploadthing"]` in
[`../../package.json`](../../package.json).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/uploadthing.test.ts   # this adapter only
bun test                             # full SDK suite
bun run build                        # tsup ESM → dist/uploadthing/
bun run types                        # tsgo --noEmit
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`); both are pinned in [`../../package.json`](../../package.json).

## Public surface

Exports from [`./index.ts`](./index.ts):

- `uploadthing(opts?: UploadThingAdapterOptions): UploadThingAdapter` —
  primary factory. `opts` is optional in the type, but you must pass
  `token` or set `UPLOADTHING_TOKEN`; otherwise construction throws.
- `UploadThingAdapter = Adapter<UTApi>`. `raw` is the `UTApi` client.
- `UploadThingAdapterOptions` — JSDoc on every field is the source of
  truth; the docs MDX pulls it via `AutoTypeTable`.

The adapter's `name` is `"uploadthing"`.

## Authentication / configuration

Required:

- **`token`** — UploadThing API token, or `UPLOADTHING_TOKEN` via
  [`readEnv`](../internal/env.ts). Must be valid base64 decoding to JSON
  with string `apiKey` and `appId`. Malformed tokens throw
  `FilesError("Provider", …)` at construction (not on first API call).

Optional (fixed at construction unless noted):

| Option                 | Default        | Role                                                                 |
| ---------------------- | -------------- | -------------------------------------------------------------------- |
| `acl`                  | `"public-read"` | `"public-read"` → CDN URLs; `"private"` → `generateSignedURL` for reads. |
| `slug`                 | —              | File-router slug; **required for `signedUploadUrl()`** (`x-ut-slug`). Server `upload()` does not need it. |
| `defaultUrlExpiresIn`  | `3600`         | Signed download TTL when `acl` is `"private"` (UploadThing caps at 7 days). |
| `downloadTimeoutMs`    | `300_000`      | Bounds `fetch` for `head`, `download`, lazy bodies; `0` disables timeout. |
| `region`               | first token region or `"sea1"` | Ingest host for `signedUploadUrl()` (`{region}.ingest.uploadthing.com`). |

There is no bucket name — UploadThing is app-scoped via `appId`. The
provider catalog entry in [`../providers/index.ts`](../providers/index.ts)
(search `slug: "uploadthing"`) declares only `UPLOADTHING_TOKEN`.

## Operation map

Errors flow through `mapUploadThingError` / `classifyUploadThingError`:
HTTP status first (`404 → NotFound`, `401/403 → Unauthorized`,
`409 → Conflict`), then message/code substrings; existing `FilesError`
instances pass through unchanged.

| Method            | Implementation                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload`          | `bodyToBlob` → `UTFile` with `customId: key`, `utapi.uploadFiles` (single-file overload), `acl` from config. Streams are buffered first.     |
| `download`        | `resolveFetchUrl` → `fetch` (GET). Public: `https://{appId}.ufs.sh/f/{key}`; private: `utapi.generateSignedURL(key, { keyType: "customId" })`. |
| `head`            | HEAD on resolved URL → `createStoredFile` with lazy GET body factory. No UploadThing metadata API.                                             |
| `exists`          | `existsByProbe` wrapping HEAD on resolved URL.                                                                                                 |
| `delete`          | `utapi.deleteFiles(key)` — idempotent upstream.                                                                                                |
| `deleteMany`      | **Native bulk:** `utapi.deleteFiles(keys)` in one call unless `stopOnError`, then per-key via `deleteManyWithFallback`. Whole-request failure maps the same error to every key. |
| `copy`            | `download(from, { as: "stream" })` then `upload(to, stream)` — not atomic; egress + ingest cost.                                             |
| `list`            | `utapi.listFiles({ limit, offset })`; `cursor` is numeric offset as string. `prefix` filtered **client-side on the page only**.                |
| `url`             | Public: CDN URL; private: `generateSignedURL`. See [URL behavior](#url-behavior).                                                              |
| `signedUploadUrl` | UFS presigned PUT: random path `fileKey`, `x-ut-custom-id` = user key, HMAC-SHA256 signature via Web Crypto. See [Signed upload](#signed-upload). |

Non-obvious behaviours backed by tests:

- **`upload` uses `basename(key)` as the UT file name** while `customId`
  stays the full key (`avatars/abc.png` → name `abc.png`).
- **`etag` on upload** comes from UploadThing's `fileHash`, not HTTP ETag.
- **`list` items** use `type: "application/octet-stream"` always; size and
  `lastModified` come from `listFiles`, not HEAD.
- **`download` merges caller `signal` with timeout** via `AbortSignal.any`
  when both are set.

## URL behavior

- **`acl: "public-read"` (default):** `url()` returns
  `https://{appId}.ufs.sh/f/{encodeURIComponent(key)}` with no API call.
- **`acl: "private"`:** `url()` calls `utapi.generateSignedURL` with
  `keyType: "customId"`; `opts.expiresIn` overrides `defaultUrlExpiresIn`.
- **`opts.responseContentDisposition` always throws `Provider`.**
  UploadThing has no Content-Disposition override on CDN or signed URLs —
  same security rationale as [`../vercel-blob/`](../vercel-blob/AGENTS.md).

## Signed upload

`signedUploadUrl(key, opts)` builds a **PUT** URL against
`https://{region}.ingest.uploadthing.com/{randomFileKey}` with query
params documented by UploadThing (`expires`, `x-ut-identifier`,
`x-ut-file-name`, `x-ut-custom-id`, `x-ut-acl`, optional `x-ut-file-type`,
`x-ut-file-size`, `x-ut-slug`). The signature is
`hmac-sha256=<hex>` over the full URL (without the signature param),
using `apiKey` from the decoded token — implemented with Web Crypto so
the adapter runs on Node 18+, Workers, Bun, and Deno without `node:crypto`.

The random path segment is **not** your logical key; routing after upload
uses `x-ut-custom-id`. Set `slug` to the file-router route name —
UploadThing enforces file type/size via router config, not the advisory
`maxSize` query param alone. Server-side `upload()` does not use `slug`.

## Provider quirks worth remembering

- **Keys vs UploadThing file keys.** Callers pass logical keys; the
  adapter stores them as `customId`. UploadThing's opaque `key` field
  exists internally and appears in `list()` only when `customId` is null.
- **No user metadata.** `UploadOptions.metadata` does not round-trip —
  UploadThing has no user-metadata primitive; `head()` / `list()` never
  return `metadata` (see `UploadOptions` JSDoc in [`../index.ts`](../index.ts)).
- **No server-side copy or HEAD API.** `copy()` and `head()` use
  download/re-upload and HTTP HEAD on the file URL respectively.
- **`list` prefix is page-local.** Filtering happens after
  `listFiles` returns a page; a narrow prefix can under-return if matching
  keys span pages.
- **Stream uploads buffer entirely** in `bodyToBlob` — UploadThing's
  `uploadFiles` requires a `Blob`; large streams need application-level
  chunking or the presigned PUT path.
- **`deleteMany` bulk semantics.** One `deleteFiles(keys)` call; on
  failure every key gets the same mapped error (no per-key partial success
  from the API). Use `stopOnError: true` for sequential per-key deletes.
- **`delete` is idempotent** upstream — missing keys still succeed.

## Testing approach

Tests in [`../../test/uploadthing.test.ts`](../../test/uploadthing.test.ts)
mock `uploadthing/server` via `mock.module(...)`, then dynamically import
the adapter. `globalThis.fetch` is stubbed for CDN/signed URL reads.
Coverage includes:

- Token validation at construction (missing, non-base64, non-JSON,
  missing `apiKey`/`appId`).
- `upload` → `uploadFiles` with `customId`, ACL, all `Body` shapes,
  `result.error` and thrown errors classified.
- `download` / `head` / `exists` public vs private URL resolution, 404
  mapping, timeout/signal behavior, lazy bodies.
- `delete` / `deleteMany` bulk and `stopOnError` fallback.
- `copy` re-upload path; `list` cursor, prefix filter, lazy item bodies.
- `url` public CDN, private signed URL, `responseContentDisposition` throw.
- `signedUploadUrl` PUT params, HMAC verification, `slug` and `region`.

Default test token: base64 `{"apiKey":"sk_test","appId":"myapp","regions":["sea1"]}`.

## Coding conventions

- Named exports only — `uploadthing`, `UploadThingAdapter`,
  `UploadThingAdapterOptions`, `UploadThingClient`. No default exports.
- Construction-time token errors use `FilesError("Provider", …)`;
  operation errors go through `mapUploadThingError`.
- Read env via [`readEnv`](../internal/env.ts) — not raw `process.env`.
- Use `createStoredFile` for every `StoredFile`; lazy factories should
  call `resolveFetchUrl` + `fetchWithTimeout`.
- Call `utapi.uploadFiles` with a **single** `UTFile` (not an array) so
  TypeScript infers `UploadFileResult` rather than an array overload.
- Keep HMAC/signing on Web Crypto — do not import `node:crypto`.
- Top-level regex literals only (`classifyUploadThingError` patterns).

## Releases

Ships with the monorepo from [`../../package.json`](../../package.json).
Behavioural changes bump `files-sdk` and need a Changesets entry; pure
docs / test additions do not. The `uploadthing` subpath is already in
`exports` — no extra wiring for new options.

## Where to look next

- Source: [`./index.ts`](./index.ts); tests:
  [`../../test/uploadthing.test.ts`](../../test/uploadthing.test.ts).
- Unified contract: [`../index.ts`](../index.ts); shared helpers:
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "uploadthing"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/uploadthing.mdx`](../../../../apps/web/content/docs/adapters/uploadthing.mdx).
- README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Upstream: [UploadThing docs](https://docs.uploadthing.com),
  [uploading files (UFS presign)](https://docs.uploadthing.com/uploading-files).
