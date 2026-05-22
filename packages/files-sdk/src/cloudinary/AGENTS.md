# AGENTS.md — `files-sdk/cloudinary`

Guidance for coding agents working on the `cloudinary` adapter
([Cloudinary](https://cloudinary.com), exposed at the `files-sdk/cloudinary`
subpath). The unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); read it first. This file documents only
cloudinary-specific behavior. Cross-references:
[`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

This is a **native** adapter built on the official [`cloudinary`](https://www.npmjs.com/package/cloudinary)
Node SDK (`cloudinary.v2`). It is **media-focused**, not a drop-in S3
replacement: assets live in Cloudinary's CDN with `public_id` keys,
`resource_type` buckets (`image` / `video` / `raw`), and delivery `type`
(`upload` / `private` / `authenticated`). The unified API maps `key` to
`public_id` and treats `url()` as a **delivery URL** (transformable on
`image`/`video` via `files.raw`), while `download()` fetches bytes over
HTTP from that delivery URL after a metadata probe.

`cloudinary(opts)` returns `CloudinaryAdapter`, which extends
`Adapter<typeof cloudinary>` with readonly `resourceType`, `type`, and
`cloudName`. `raw` is the `cloudinary.v2` namespace — use it for
upload presets, eager transforms, `context`/`metadata` parameters, and
anything outside the common subset. Peer dep: `cloudinary` (see
[`../../package.json`](../../package.json) `peerDependencies`).

## Directory layout

```text
packages/files-sdk/src/cloudinary/
├── index.ts          # cloudinary() factory + CloudinaryAdapterOptions
├── AGENTS.md         # this file
└── CLAUDE.md         # `@AGENTS.md` — Claude-Code re-export
```

Sibling files: tests at
[`../../test/cloudinary.test.ts`](../../test/cloudinary.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/cloudinary.mdx`](../../../../apps/web/content/docs/adapters/cloudinary.mdx);
subpath export at `exports["./cloudinary"]` in
[`../../package.json`](../../package.json).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/cloudinary.test.ts   # this adapter only
bun test                            # full SDK suite
bun run build                       # tsup ESM → dist/cloudinary/
bun run types                       # tsgo --noEmit
```

This package uses **`bun test`** and **`tsgo`** (not vitest/tsc).

## Public surface

Exports from [`./index.ts`](./index.ts):

- `cloudinary(opts?: CloudinaryAdapterOptions): CloudinaryAdapter` —
  primary factory. Alias: `cloudinaryAdapter`.
- `CloudinaryAdapter` — `Adapter<typeof cloudinary>` plus
  `resourceType`, `type`, `cloudName`.
- `CloudinaryAdapterOptions`, `CloudinaryResourceType`,
  `CloudinaryDeliveryType`.
- `mapCloudinaryError` — exported for tests; maps provider errors to
  `FilesError` via [`makeErrorMapper`](../internal/core.ts).

The adapter's `name` is `"cloudinary"`. There is no `deleteMany` —
the SDK fans out to `delete()` when callers use bulk delete on `Files`.

## Authentication / configuration

Required:

- `cloudName` — string. Falls back to `CLOUDINARY_CLOUD_NAME` or the
  cloud segment parsed from `CLOUDINARY_URL`. Missing value throws
  `FilesError("Provider", …)` at construction.

Optional (needed for `signedUploadUrl()` and for `url()` on
`private` / `authenticated` assets):

- `apiKey` — `CLOUDINARY_API_KEY` or parsed from `CLOUDINARY_URL`.
- `apiSecret` — `CLOUDINARY_API_SECRET` or parsed from `CLOUDINARY_URL`.

`CLOUDINARY_URL` format (parsed by top-level regex in
[`./index.ts`](./index.ts)):

```text
cloudinary://<api_key>:<api_secret>@<cloud_name>
```

Malformed URLs are ignored; discrete env vars still apply.

Other knobs:

| Option                 | Default    | Role                                                                 |
| ---------------------- | ---------- | -------------------------------------------------------------------- |
| `resourceType`         | `"raw"`    | Cloudinary bucket: arbitrary bytes vs `image`/`video` transforms.      |
| `type`                 | `"upload"` | Delivery type: public CDN vs access-controlled.                      |
| `secure`               | `true`     | HTTPS delivery URLs (`sdk.config({ secure })`).                      |
| `signedUrlExpiresIn`   | `3600`     | Default expiry for signed delivery URLs (`private`/`authenticated`). |
| `client`               | —          | Pre-configured `cloudinary.v2`; skips `sdk.config()` (see quirks).   |

Env vars are read via [`readEnv`](../internal/env.ts) (Workers-safe).
Provider catalog: search `slug: "cloudinary"` in
[`../providers/index.ts`](../providers/index.ts).

## Keys, folders, and the media model

- **`key` ↔ `public_id`.** Every operation passes `key` as Cloudinary's
  `public_id`. Slashes are folder segments (`user-1/avatar.png`), not
  a separate bucket name — there is no `bucket` option.
- **`list({ prefix })`** maps to Admin API `prefix` (folder filter).
  Pagination uses opaque `cursor` ↔ `next_cursor`.
- **`resource_type` is fixed per adapter instance.** Pick `"raw"` for
  S3-style arbitrary files; `"image"` / `"video"` when you want format
  inference (`image/png`, `video/mp4`) and transformation URLs from
  `files.raw.url(...)`. The unified adapter does not embed transform
  parameters in `url()` — that stays on the SDK escape hatch.
- **Delivery vs storage.** `upload()` ingests via Admin upload API;
  `url()` returns CDN delivery URLs (`sdk.url` or
  `sdk.utils.private_download_url`). `download()` GETs the delivery URL
  (not a separate "raw storage" endpoint). Transformed bytes are
  whatever the delivery URL serves; for untransformed originals on
  images, use `raw` resource type or signed admin download via `raw`.

## Operation map

Errors flow through `mapCloudinaryError` — classification is **HTTP
status only** (`404 → NotFound`, `401/403 → Unauthorized`; empty
provider code sets). `exists` uses
[`existsByProbe`](../internal/core.ts) on `sdk.api.resource`.

| Method            | Implementation                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `upload`          | Buffer body → `sdk.uploader.upload_stream` with `public_id: key`, `overwrite: true`, `invalidate: true`. Returns `response.public_id` as `key`. |
| `download`        | Parallel `sdk.api.resource` + `fetch(sdk.url(key))`. `signal` forwarded to fetch. 404 → `NotFound`. |
| `head`            | `sdk.api.resource` → `createStoredFile` with lazy body factory (same delivery fetch as download). |
| `exists`          | Probe `sdk.api.resource`; `NotFound` → `false`.                                                   |
| `delete`          | `sdk.uploader.destroy` with `invalidate: true`.                                                   |
| `copy`            | **No native copy.** `sdk.uploader.upload(sourceDeliveryUrl, { public_id: to })` — re-ingest from CDN URL. New `asset_id` / `etag`. |
| `list`            | `sdk.api.resources` with `prefix`, `next_cursor`, `max_results` (default 100, max 500). Items use `public_id` as `key`, lazy bodies. |
| `url`             | See [URL behavior](#url-behavior).                                                                |
| `signedUploadUrl` | Local `sdk.utils.api_sign_request` + POST to `https://api.cloudinary.com/v1_1/{cloud}/{resourceType}/upload`. |

Rejected `UploadOptions`:

- `cacheControl` — throws `Provider` (no per-asset HTTP cache headers).
- `metadata` with keys — throws `Provider`; empty `{}` is allowed.

Rejected `UrlOptions`:

- `responseContentDisposition` — throws `Provider`.

## URL behavior

Behavior depends on constructor `type`:

- **`type: "upload"` (default).** `url(key)` returns `sdk.url(key, {
  resource_type, type, secure })` — a **public, non-expiring** delivery
  URL. `opts.expiresIn` is ignored. This is the normal path for public
  assets and for `raw` arbitrary-byte storage.
- **`type: "private"` or `"authenticated"`.** `url()` first calls
  `sdk.api.resource` to read `format`, then
  `sdk.utils.private_download_url(key, format, { expires_at, resource_type, type })`.
  Expiry: `opts.expiresIn ?? signedUrlExpiresIn` (default 3600 via
  [`DEFAULT_URL_EXPIRES_IN`](../internal/core.ts)). **Raw assets without
  a stored `format`** cannot be signed — error tells callers to put the
  extension in `public_id`.
- **No `publicBaseUrl` knob.** Cloudinary's CDN origin is implicit in
  `sdk.url`; callers don't configure a separate origin.

Signed upload shape differs from S3-style presigned PUT:

- `method: "POST"`, `url` = Admin upload endpoint, `fields` =
  `{ api_key, public_id, signature, timestamp, content_type? }`.
- Requires `apiKey` + `apiSecret` at construction.
- `SignUploadOptions.expiresIn` / `maxSize` / `minSize` are not enforced
  by this adapter (Cloudinary signatures are ~1h; size limits need an
  upload preset via `raw`).

## Provider quirks worth remembering

- **Global SDK config.** Unless `client` is passed, the factory calls
  `sdk.config({ cloud_name, api_key, api_secret, secure })` on the
  module-level `cloudinary.v2` namespace. Multiple adapters with
  different credentials in one process: **last config wins**. Use
  separate pre-configured `client` instances for isolation.
- **`upload_stream` is callback-shaped.** Wrapped in a Promise locally;
  don't expect an upstream promise API.
- **`copy()` is ingest-by-URL, not byte copy.** Source must be reachable
  at its delivery URL; duplicates billing/transform pipeline semantics.
- **`download()` / lazy `head()` / `list()` hit the CDN.** Admin API
  for metadata only; body transfer is `fetch` on the delivery URL.
- **Invalidation on write/delete.** `invalidate: true` on upload and
  destroy busts CDN cache — good for freshness, costly at scale.
- **List ceiling.** `limit` clamped to 500 (Cloudinary Admin API max).
- **Image/video transforms** live outside the unified API. With
  `resourceType: "image"` or `"video"`, callers build transform URLs via
  `files.raw.url(publicId, { transformation: [...] })` or upload-time
  `transformation` / `eager` on `files.raw.uploader.upload`.
- **No `deleteMany`.** Bulk delete fans out in `Files` with bounded
  concurrency.

## Testing approach

Tests in [`../../test/cloudinary.test.ts`](../../test/cloudinary.test.ts)
mock `cloudinary` via `mock.module("cloudinary", …)` and stub
`globalThis.fetch` for download paths. Coverage areas:

- Construction: missing `cloudName`, `CLOUDINARY_URL` parse, discrete
  env vars, malformed URL fallback, `client` skips `config()`.
- Defaults: `resourceType: "raw"`, `type: "upload"`.
- `upload`: `upload_stream` opts (`public_id`, `overwrite`), body shapes
  (string, `Uint8Array`, `ReadableStream`), `cacheControl`/`metadata`
  throws, empty metadata allowed, `image`/`video` content-type inference.
- `download` / `head`: lazy fetch, 404/500 classification, `signal`
  forwarded.
- `exists`: true/false/401 rethrow.
- `delete` / `copy` / `list`: delegation, prefix/cursor, limit clamp 500.
- `url`: public `sdk.url`, private signed URL + `expiresIn`,
  `responseContentDisposition` throw, missing `format` on private raw.
- `signedUploadUrl`: POST shape, signature params, missing secret throw.
- `mapCloudinaryError`: 404/401 mapping, `FilesError` passthrough.

Add cloudinary-specific cases here; shared `Files` behavior belongs in
core tests.

## Coding conventions

- Named exports only — `cloudinary`, `cloudinaryAdapter`,
  `CloudinaryAdapter`, `CloudinaryAdapterOptions`, `mapCloudinaryError`.
- Construction-time misconfig → `FilesError("Provider", …)`; operations
  wrap caught errors with `mapCloudinaryError` (preserves existing
  `FilesError`).
- Env via [`readEnv`](../internal/env.ts) — never bare `process.env`.
- Use [`createStoredFile`](../internal/stored-file.ts) for all
  `StoredFile` returns; lazy download factory matches other adapters.
- Body normalization via [`normalizeBody` / `collectStream`](../internal/core.ts)
  in `toBuffer` before `upload_stream`.
- Top-level regex only (`parseCloudinaryUrl`). Keep upload_stream's
  `new Promise` wrapper — upstream has no promise API.
- When adding options, update JSDoc on `CloudinaryAdapterOptions` (MDX
  `AutoTypeTable` reads it), provider catalog env block, and tests.

## Releases

Ships with the monorepo from [`../../package.json`](../../package.json).
Behavioral changes bump `files-sdk` version and
[`../../CHANGELOG.md`](../../CHANGELOG.md); docs/tests-only need no
version bump. The `./cloudinary` export is already wired in `exports`
and [`../../tsup.config.ts`](../../tsup.config.ts).

## Where to look next

- Source: [`./index.ts`](./index.ts); tests:
  [`../../test/cloudinary.test.ts`](../../test/cloudinary.test.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/cloudinary.mdx`](../../../../apps/web/content/docs/adapters/cloudinary.mdx).
- Provider catalog (search `slug: "cloudinary"`):
  [`../providers/index.ts`](../providers/index.ts).
- Unified contract: [`../index.ts`](../index.ts); shared helpers:
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- CLI registry entry: [`../cli/registry.ts`](../cli/registry.ts)
  (`cloudinary` slug).
