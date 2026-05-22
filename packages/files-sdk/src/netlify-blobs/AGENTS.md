# AGENTS.md — `files-sdk/netlify-blobs`

Guidance for coding agents working inside the Netlify Blobs adapter. Every
adapter in files-sdk implements the same `Adapter<Raw>` contract from
[`../index.ts`](../index.ts); this file documents only the deviations and
pitfalls specific to `netlify-blobs`. The package-wide
[`README.md`](../../README.md) and the agent skill at
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md) are the sources of
truth for the unified API — read them first.

`netlify-blobs` is a **native** adapter built directly on
[`@netlify/blobs`](https://www.npmjs.com/package/@netlify/blobs). It does
not wrap `s3()` — Netlify Blobs has its own protocol, no SigV4, no public
URL primitive, and no presigned-upload primitive, so every operation runs
against the `@netlify/blobs` `Store` API.

## Overview

Family: **edge/serverless blob, native**. `upload`, `download`, `head`,
`exists`, `delete`, `copy`, and `list` are implemented in
[`index.ts`](./index.ts) on top of `Store.set`, `Store.get`,
`Store.getMetadata`, `Store.getWithMetadata`, `Store.delete`, and
`Store.list`. `url` and `signedUploadUrl` throw `FilesError("Provider", …)`
— Netlify has neither primitive.

Netlify Blobs has **no native fields for content type, size, or
last-modified**. The adapter packs those plus `cacheControl` and user
`metadata` into Netlify's per-object `metadata` map at upload time, then
reads them back on `head()` / `download()` / `list()` so the unified
`StoredFile` shape matches the cloud adapters.

Peer dependency (optional, declared in [`../../package.json`](../../package.json)): `@netlify/blobs`.

## Directory layout

```text
packages/files-sdk/src/netlify-blobs/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # @AGENTS.md — Claude-Code re-export
```

Sibling files outside this directory:

- Tests: [`../../test/netlify-blobs.test.ts`](../../test/netlify-blobs.test.ts)
- User docs: [`../../../../apps/web/content/docs/adapters/netlify-blobs.mdx`](../../../../apps/web/content/docs/adapters/netlify-blobs.mdx)
- Provider catalog entry: [`../providers/index.ts`](../providers/index.ts) (search `slug: "netlify-blobs"`)

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/netlify-blobs.test.ts   # this adapter's tests only
bun test                              # full SDK suite
bun run build                         # tsup → dist/netlify-blobs/index.js
bun run types                         # tsgo --noEmit (typecheck)
```

`bun test` is the runner (not vitest); `tsgo` is the typechecker (not
`tsc`). The per-subpath bundle output is `dist/netlify-blobs/index.{js,d.ts}`
per the `exports` map in [`../../package.json`](../../package.json).

## Public surface

Defined in [`index.ts`](./index.ts):

- `netlifyBlobs(opts: NetlifyBlobsAdapterOptions): NetlifyBlobsAdapter` —
  factory. Throws `FilesError("Provider", …)` synchronously if `name` is
  missing or non-string, and re-wraps `getStore()` / `getDeployStore()`
  failures via `mapNetlifyError`.
- `NetlifyBlobsAdapterOptions` — config interface (`name`, `siteID`,
  `token`, `deployScoped`, `consistency`). JSDoc on every field is the
  source of truth; the docs MDX pulls it via `AutoTypeTable`.
- `NetlifyBlobsClient` — alias for the `@netlify/blobs` `Store`.
- `NetlifyBlobsAdapter` — alias for `Adapter<NetlifyBlobsClient>`. `raw`
  is the underlying `Store`; anything `@netlify/blobs` exposes that the
  unified surface doesn't (`setJSON`, the SDK's typed JSON helper, plus
  any future primitives) is one property access away on `files.raw`.

The adapter's `name` is `"netlify-blobs"`.

## Authentication / configuration

Required:

- `name` — Netlify store name. Every operation runs against this store
  (max 64 bytes per Netlify's limit). Missing or non-string throws
  `FilesError("Provider", …)` at construction.

Optional:

- `siteID` — falls back to `NETLIFY_SITE_ID` via [`readEnv`](../internal/env.ts).
- `token` — falls back to `NETLIFY_API_TOKEN`, then `NETLIFY_BLOBS_TOKEN`.
- `deployScoped` — `false` (default) selects `getStore()` (site-scoped,
  persists across deploys); `true` selects `getDeployStore()` (lifetime
  of the current deploy, for build artifacts that should be
  garbage-collected with it).
- `consistency` — `"eventual"` (default, edge-cache reads) or `"strong"`
  (origin reads, read-your-writes). Threaded straight through to the SDK.

`siteID` and `token` are passed to the Netlify SDK **only when both are
set together**. If either is missing the adapter omits both and lets the
SDK pick up its ambient context from `NETLIFY_BLOBS_CONTEXT`, which
Netlify Functions / Edge Functions / build runtimes inject automatically
— that's the common configuration on Netlify; explicit creds are required
only outside Netlify (local scripts, your own server). When neither path
resolves, the SDK surfaces `MissingBlobsEnvironmentError` on first call,
classified as `Provider`.

## Operation map

Every method goes through `mapNetlifyError`, which forwards `FilesError`
instances unchanged and otherwise extracts a status code from the
provider error message (see [Provider quirks](#provider-quirks-worth-remembering)).

- `upload` — `bodyToStorable` normalizes the body to `string | ArrayBuffer
  | Blob` (the shapes `Store.set` accepts). `Uint8Array` /
  `ArrayBufferView` are sliced into fresh `ArrayBuffer`s so the SDK never
  sees a view covering more bytes than the user's. `ReadableStream` is
  buffered up-front via `new Response(body).arrayBuffer()` — `set()` has
  no streaming form. Result size prefers `sizeOf(body)` and falls back
  to the buffered length.
- `download` — `Store.getWithMetadata` in `"arrayBuffer"` (default) or
  `"stream"` mode (when `opts.as === "stream"`). The buffered path
  reports the **actual byte length**, falling back to packed `__size`
  only when the buffer is empty — so blobs written outside the SDK still
  report a sensible size. `null` → `NotFound`.
- `head` — `Store.getMetadata` only; no body transfer. The returned
  `StoredFile`'s body accessors lazily issue a `Store.get` on first use
  — not free.
- `exists` — `Store.getMetadata`. `null` → `false`; a mapped `NotFound`
  (404 in the SDK's internal-error message) also → `false`. Every other
  error propagates.
- `delete` — `Store.delete`. Idempotent: calling on a missing key
  succeeds and does not throw.
- `copy` — **no native primitive.** Read-then-write via
  `getWithMetadata(from)` + `set(to, …)`. The source's packed metadata
  is forwarded verbatim so `contentType`, `size`, user `metadata`, and
  `cacheControl` round-trip; `__lastModified` is refreshed to the time of
  the copy (matches S3 server-side copy semantics). **Not server-side
  atomic** — concurrent writes to `from` between the get and put are not
  detected.
- `list` — `Store.list({ paginate: true, prefix? })` async iterator.
  `paginate` is always set so a small `limit` actually bounds
  server-side I/O; iteration stops once `blobs.length >= limit`. Items
  carry `size: 0` and `type: "application/octet-stream"` with a lazy
  body factory (a fresh `Store.get`) — Netlify's list response only
  carries `key` + `etag`. `ListResult.cursor` is always `undefined` —
  Netlify's pagination cursor is internal to the iterator.
- `url` / `signedUploadUrl` — both throw `FilesError("Provider", …)`
  with a netlify-specific message. See [URL behavior](#url-behavior).
- `deleteMany` — not implemented; the SDK falls back to bounded-
  concurrency fan-out via `deleteManyWithFallback` in
  [`../internal/core.ts`](../internal/core.ts). Netlify has no bulk-
  delete primitive, so a native impl wouldn't win round-trips.

## URL behavior

`url(key, opts?)` always throws. No `publicBaseUrl` knob, no signing
primitive — Netlify Blobs reads require the access token and go through
`@netlify/blobs`. If you need permanent public URLs, copy the blob to a
different provider (S3 + CDN, Vercel Blob public) at upload time.

`signedUploadUrl(key, opts)` throws the same way. Direct browser uploads
aren't possible; upload from your server using the SDK, or proxy the
request through an authenticated endpoint that calls `files.upload(...)`
on the client's behalf. Both throws are deliberate and asserted in the
test suite — don't paper over them with a "best-effort" implementation.

## Provider quirks worth remembering

- **No size / content-type / last-modified in Netlify's wire format.** The
  adapter packs them under reserved metadata keys (`__contentType`,
  `__size`, `__lastModified`, `__cacheControl`, `__user`). User metadata
  round-trips under `__user` so it can never collide with the internal
  fields. Blobs written outside the SDK have no packed metadata and read
  back as `size: 0` (or actual byte length on the buffered `download`
  path) and `type: "application/octet-stream"`.
- **`set()` doesn't take streams.** `ReadableStream` bodies are buffered
  in full before upload. Memory cost scales with body size; chunk at the
  application layer or pick a different provider for large uploads.
- **Error classification rides on the message string.** Netlify throws
  `BlobsInternalError` whose `message` embeds the upstream status
  (`"… (401 status code, ID: …)"`). `classifyNetlifyError` pattern-matches
  `\(\d{3} status code\)` because the SDK has no structured `status`
  field. Buckets follow the unified mapping: 404 → `NotFound`, 401/403
  → `Unauthorized`, 409/412 → `Conflict`, else → `Provider`; message-only
  fallbacks catch `/not found/i` and `/unauthor|forbidden/i` when no
  status is present. `MissingBlobsEnvironmentError` → `Provider`.
- **Two store types, one adapter.** `deployScoped: true` swaps the
  factory for `getDeployStore()`; everything else (metadata packing,
  error mapping, op delegation) is identical. Pick deploy-scoped only
  for build artifacts that should be garbage-collected with the deploy.
- **`consistency` is per-store, not per-call.** It binds to the `Store`
  instance returned at construction — every read on the adapter uses
  that mode.

## Testing approach

Tests in [`../../test/netlify-blobs.test.ts`](../../test/netlify-blobs.test.ts)
use `bun:test` with `mock.module("@netlify/blobs", …)` to swap the SDK
for an in-memory `Map` plus mocked `set` / `get` / `getMetadata` /
`getWithMetadata` / `delete` / `list`. The matrix covers:

- `getStore` vs `getDeployStore` selection, `consistency` threading, and
  the explicit-vs-env-vs-ambient credential ladder (including the
  `NETLIFY_BLOBS_TOKEN` fallback).
- Upload across every body shape and the metadata packing
  (`__contentType`, `__size`, `__cacheControl`, `__lastModified`,
  `__user.*`).
- Download buffered vs streaming, `head()` lazy-body fetch, `exists`'
  swallow-`NotFound` / rethrow-other behaviour, and `copy()`'s metadata
  round-trip plus refreshed `__lastModified`.
- `list()` pagination: `paginate: true` is forwarded; a small `limit`
  stops iterating early (`listPagesYielded` asserts the perf-cliff fix);
  no `cursor` is returned.
- `url()` / `signedUploadUrl()` throw `Provider`; error mapping for each
  status (401, 403, 404, 409, 500), `MissingBlobsEnvironmentError`,
  message-only `"not found"` / `"forbidden"`, and stream errors during
  upload.

The shared `FakeAdapter` at [`../../test/fake-adapter.ts`](../../test/fake-adapter.ts)
is for `Files`-class tests, not adapter unit tests — new netlify-blobs
tests go in `netlify-blobs.test.ts` and mock the SDK directly.

## Coding conventions

- Named exports only — no default exports.
- Errors wrap as `FilesError` via `mapNetlifyError`. Existing
  `FilesError` instances pass through unchanged.
- Internal metadata keys (`__contentType`, `__size`, `__lastModified`,
  `__cacheControl`, `__user`) are reserved. Pick a fresh `__`-prefixed
  key for new features so existing blobs keep reading correctly.
- Use `createStoredFile` from [`../internal/stored-file.ts`](../internal/stored-file.ts)
  for every `StoredFile` you return. Don't hand-roll body accessors.
- Env reads go through [`readEnv`](../internal/env.ts). Direct
  `process.env` access breaks Cloudflare Workers without `nodejs_compat`
  (and the Netlify Edge runtime is similar).
- Top-level regex literals only — the current file has one (`STATUS_RE`).
- Don't introduce a `signedUploadUrl` or `url` implementation without
  upstream support — the current throw is deliberate and tested.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioural changes need a
changeset (`bunx changeset`, then commit the entry under `.changeset/`).
README updates and AGENTS.md edits don't require one. The
`netlify-blobs` subpath is already declared in `exports` — no further
wiring needed for new options.

## Where to look next

- Source + tests: [`./index.ts`](./index.ts), [`../../test/netlify-blobs.test.ts`](../../test/netlify-blobs.test.ts)
- User-facing docs: [`../../../../apps/web/content/docs/adapters/netlify-blobs.mdx`](../../../../apps/web/content/docs/adapters/netlify-blobs.mdx)
- Provider catalog entry (`slug: "netlify-blobs"`): [`../providers/index.ts`](../providers/index.ts)
- Unified `Adapter` contract: [`../index.ts`](../index.ts)
- Shared helpers: [`../internal/core.ts`](../internal/core.ts), [`../internal/errors.ts`](../internal/errors.ts), [`../internal/env.ts`](../internal/env.ts)
- Package README & skill: [`../../README.md`](../../README.md), [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
