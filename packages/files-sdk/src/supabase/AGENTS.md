# AGENTS.md — `files-sdk/supabase`

Guidance for coding agents working inside the Supabase Storage adapter.
Every adapter implements the same `Adapter<Raw>` contract from
[`../index.ts`](../index.ts); this file documents only
`supabase`-specific deviations. The package-wide
[README.md](../../README.md) and the agent skill at
[`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
cover the unified API — read them first.

`supabase` is a **native** adapter: it talks directly to
[Supabase Storage](https://supabase.com/docs/guides/storage) through
`@supabase/storage-js`, not through an S3-compatible endpoint. Every
method calls a Supabase primitive (`upload`, `download`, `list`,
`remove`, `copy`, `info`, `getPublicUrl`, `createSignedUrl`,
`createSignedUploadUrl`). That gives us native bulk delete, server-side
copy, and the public/signed/CDN URL trichotomy at the cost of
duplicating body normalization and error mapping the S3 path gets for
free.

## Overview

One `StorageClient` per adapter instance; one
`bucketRef = client.from(bucket)` per call. Buckets must already exist
— this SDK never calls `createBucket`. Bucket visibility (public vs
private) is a server-side property; the adapter mirrors it through
`opts.public` so `url()` knows which primitive to mint.

Peer dependency (optional, declared in
[`../../package.json`](../../package.json)): `@supabase/storage-js`.
`@supabase/supabase-js` is **not** required — pass a bare
`StorageClient` or any `{ storage: StorageClient }` and the adapter
picks the right thing.

## Directory layout

```text
packages/files-sdk/src/supabase/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files:

- Tests: [`packages/files-sdk/test/supabase.test.ts`](../../test/supabase.test.ts)
- User docs: [`apps/web/content/docs/adapters/supabase.mdx`](../../../../apps/web/content/docs/adapters/supabase.mdx)
- Provider catalog entry: [`packages/files-sdk/src/providers/index.ts`](../providers/index.ts) (search for `slug: "supabase"`)

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/supabase.test.ts      # this adapter's tests
bun test                            # full suite
bun run build                       # tsup ESM bundle -> dist/supabase/
bun run types                       # tsgo --noEmit
```

`bun test` (not vitest) and `tsgo` (not `tsc`) are pinned. Per-subpath
bundle output is `dist/supabase/index.{js,d.ts}` per the `exports` map
in [`../../package.json`](../../package.json).

## Public surface

Defined in [`index.ts`](./index.ts):

- `supabase(opts: SupabaseAdapterOptions): SupabaseAdapter` — factory.
- `SupabaseAdapterOptions` — `bucket`, `client`, `url`, `key`, `public`,
  `publicBaseUrl`, `defaultUrlExpiresIn`. JSDoc on every field is the
  source of truth; the docs MDX pulls it via `AutoTypeTable`.
- `SupabaseAdapter` — `Adapter<StorageClient> & { readonly bucket }`.
  `raw` is the underlying `StorageClient` (or whatever was passed via
  `client`).
- `mapSupabaseError(err?): FilesError` — exported for callers reusing
  the same classification on errors pulled off `raw`. The optional
  argument matches `@supabase/storage-js`'s `{ error: null }` shape
  that some call sites pass straight through.

## Authentication / configuration

Three credential modes, in precedence order:

1. **`opts.client`** — wins over everything. Accepts a `StorageClient`
   directly or any `{ storage: StorageClient }` shape (a
   `SupabaseClient` from `@supabase/supabase-js`). When set, **no**
   `StorageClient` is constructed and **no** env vars are read.
2. **`opts.url` + `opts.key`** — explicit. `url` is the project URL
   (`https://xxxx.supabase.co`); the adapter appends `/storage/v1`,
   strips trailing slashes, and does not duplicate the suffix when
   already present.
3. **Env fallbacks** — URL: `SUPABASE_URL`, then
   `NEXT_PUBLIC_SUPABASE_URL`. Key: `SUPABASE_SERVICE_ROLE_KEY`, then
   `SUPABASE_KEY`, then `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

The service-role key is required for write operations on RLS-protected
buckets; the anon key works for public buckets and any operations RLS
policies permit. Missing both throws `FilesError("Provider", …)` at
construction with a message naming every env alias. `bucket` has **no
env fallback**. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe on runtimes
without `process` (Cloudflare Workers without `nodejs_compat`). The
constructed client gets both `Authorization: Bearer ${key}` and
`apikey: ${key}` headers — Supabase Storage requires both.

## Operation map

Every method dispatches via `bucketRef = client.from(bucket)` and routes
errors through `mapSupabaseError`.

- `upload` — `bucketRef.upload(key, data, { contentType,
  upsert: true, cacheControl?, metadata? })`. Body runs through a
  **local** `normalizeBody` (not the shared one) because Supabase
  accepts `Blob` natively but ignores `FileOptions.contentType` for
  `Blob`/`File` — those go multipart and use the Blob's own `type`.
  When the caller passes an override `contentType` for a `Blob`, the
  adapter drains it to a `Uint8Array` so the override sticks.
  `ReadableStream` bodies are forwarded with `duplex: "half"`; the
  adapter follows up with `info()` to populate authoritative
  `size`/`etag`/`lastModified` since the upload response carries none.
- `download` — `bucketRef.download(key)` for buffered mode,
  `.download(key).asStream()` for streaming. Buffered mode falls back
  to `info()` when `Blob.type` comes back empty (Supabase sometimes
  doesn't echo Content-Type). Stream mode always issues an `info()` for
  metadata since the stream form returns no headers. Both forward
  `AbortSignal` via the trailing `FetchParameters` slot.
- `head` — `bucketRef.info(key)`. No separate HEAD primitive exists;
  `info()` is the cheapest metadata probe. The returned `StoredFile`'s
  body accessors lazily issue a `download()` on first use.
- `exists` — `bucketRef.info(key)` and classify the error.
  `mapped.code === "NotFound"` returns `false`; anything else
  (auth, transport) rethrows.
- `delete` — `bucketRef.remove([key])`. Idempotent: empty array (not
  an error) on missing key, matching S3/Azure's silent-on-missing.
- `deleteMany` — **native bulk** via `bucketRef.remove(keys)` in one
  request. No documented per-request key cap, so the whole list goes
  through unchunked. The API surfaces only a single batch-level error
  rather than per-key failures; on failure the mapped error is attached
  to every input key. `stopOnError: true` falls back to
  `deleteManyWithFallback` (sequential per-key `remove`) so the stop
  point lands on a specific key.
- `copy` — `bucketRef.copy(from, to)` server-side. Supabase also
  exposes `.move(from, to)` but the unified API has no `move` — copy +
  delete is the caller's pattern.
- `list` — `bucketRef.list(prefix, { limit, offset })`. **Offset/limit,
  not cursor-based.** The adapter encodes the next offset as a numeric
  string cursor so it threads through the unified `cursor` field,
  emitting it only when the page came back full. Non-numeric cursors
  throw `FilesError("Provider", …)` at the boundary. Supabase returns
  just the leaf `name` per item; the adapter re-prefixes so the
  returned `key` round-trips through `head`/`download`/`delete`. Each
  item's body factory issues a fresh `download()` on demand.
- `url` — three-state strategy (see below).
- `signedUploadUrl` — `bucketRef.createSignedUploadUrl(key,
  { upsert: true })`. Always returns
  `{ method: "PUT", url, headers: { "Content-Type"?, "x-upsert": "true" } }`.
  Never POST.

## URL behavior

Supabase has more URL strategies than the standard two-state
`resolveUrlStrategy` helper supports, so the adapter implements the
precedence directly. In order:

1. **`opts.responseContentDisposition` always forces signing** — even
   when `publicBaseUrl` or `public: true` is set. Without a signature
   there's nowhere to bind the override, and silently dropping it would
   be a stored-XSS regression on user-uploaded HTML/SVG.
2. **`publicBaseUrl`** — `${publicBaseUrl}/${key}` via `joinPublicUrl`
   from [`../internal/core.ts`](../internal/core.ts). Use when a CDN
   sits in front of the project. Skips both signing and
   `getPublicUrl()`.
3. **`public: true`** — `bucketRef.getPublicUrl(key)`. Permanent,
   unsigned URL at the project's storage origin. The adapter can't
   verify bucket visibility from the client; setting `public: true` on
   a private bucket means reads 4xx.
4. **Default (private)** — `bucketRef.createSignedUrl(key, expiresIn,
   { download? })`. `expiresIn` falls through per-call →
   `opts.defaultUrlExpiresIn` → `DEFAULT_URL_EXPIRES_IN` (3600s).
   `responseContentDisposition` binds as the Supabase API's `download`
   option (their name, not ours).

## Provider quirks worth remembering

- **Bucket visibility is server-side, not per-key.** Supabase exposes
  no client API to detect public-vs-private; the adapter mirrors the
  bucket flag through `opts.public` and trusts the caller. Get it
  wrong and reads 4xx.
- **`signedUploadUrl` ignores `expiresIn`.** Supabase fixes the TTL at
  2 hours server-side and offers no per-URL override. The field is
  accepted (the unified contract requires it) but silently dropped.
- **`maxSize` on `signedUploadUrl` throws.** No `content-length-range`
  equivalent — no way to enforce a max upload size at the URL level.
  The adapter throws `FilesError("Provider", …)` rather than silently
  no-op (same honest-API stance Azure takes for the same gap). Enforce
  caps via the bucket-level file size limit in the Supabase dashboard
  or at a gateway in front of the signed URL.
- **Blob uploads with an override `contentType` are drained.** Supabase
  sends `Blob`/`File` as multipart and uses the Blob's own `type` for
  the part. The adapter drains to a `Uint8Array` when an override
  differs, so the caller's `contentType` always wins.
- **`ReadableStream` uploads need `duplex: "half"`.** Set automatically
  when `data instanceof ReadableStream`; without it undici refuses to
  upload streams. Stream uploads also do a follow-up `info()` for
  size/etag/lastModified since the upload response carries none.
- **`list()` returns leaf names, not full keys.** The adapter
  re-prefixes them so the returned `key` round-trips through every
  other method. Watch this if you add new list paths.
- **`info()` may not exist on older deployments.** Every non-essential
  `info()` call goes through `safeInfo`, which swallows both errors
  and exceptions; downstream value falls back to `0` /
  `"application/octet-stream"` rather than failing the call.
- **`etag` is stripped of surrounding quotes** (Supabase returns
  `"abc"` with literal `"`; `stripEtag` removes them, matching S3).
- **`metadata` round-trips best-effort.** The SDK threads
  `FileOptions.metadata` through, but the API may or may not echo it
  back via `info()`/`list()`. Don't rely on it for anything the bucket
  can't reconstruct from key + body.
- **RLS sits between the API and the bucket.** Even with the service
  role, RLS policies on `storage.objects` apply (usually bypassed when
  the service-role key is configured). Anon-key callers need matching
  policies for every operation — including `list`, which surfaces as a
  SELECT on `storage.objects`. RLS denials surface as `Unauthorized`.
- **Error classification keys.** `SUPABASE_NOT_FOUND_CODES =
  { NotFound, NoSuchKey }`, `SUPABASE_UNAUTH_CODES = { InvalidJWT,
  Unauthorized, AccessDenied, InvalidKey }`, `SUPABASE_CONFLICT_CODES =
  { Duplicate, AlreadyExists }`. HTTP status buckets (404 / 401-403 /
  409-412) provide a fallback. `extract` prefers the string
  `statusCode` (the server's code name); a numeric `statusCode` is
  treated as the HTTP status.

## Testing approach

Tests in [`../../test/supabase.test.ts`](../../test/supabase.test.ts)
use `mock.module("@supabase/storage-js", ...)` to swap in a
`StorageClientStub` plus a hand-built `bucketRef` of `bun:test` mocks
(one per primitive). The pattern covers construction precedence
(explicit `client` skips both `StorageClient` construction and env
reads; `/storage/v1` suffix handling; trailing-slash stripping), body
handling for every `Body` variant including `Blob` with and without
override and `ReadableStream` with `duplex: "half"`, the three-state
`url()` strategy plus the `responseContentDisposition`-forces-signing
rule on both `publicBaseUrl` and `public: true` configs, `list()`
cursor encode/decode and re-prefixing, `deleteMany` native bulk vs
`stopOnError` per-key fallback, `signedUploadUrl` PUT shape and the
`maxSize`-throws guard, error mapping for every classified code, and
`AbortSignal` forwarding via `FetchParameters` on `download` /
stream-download / `list`.

`bun test` is the runner — no vitest config. The shared `FakeAdapter`
at [`../../test/fake-adapter.ts`](../../test/fake-adapter.ts) is for
`Files`-class tests, **not** adapter unit tests; new supabase tests
mock `@supabase/storage-js` directly.

## Coding conventions

- Named exports only — no default exports.
- Errors wrap as `FilesError` via `mapSupabaseError`; pass through
  existing `FilesError` instances unchanged (the mapper short-circuits
  on them). Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts) with a message
  that names the env-var aliases. Don't throw raw `Error` from the
  factory.
- Read env via [`readEnv`](../internal/env.ts); direct `process.env`
  breaks Cloudflare Workers without `nodejs_compat`.
- Body normalization is **local** to this adapter (`normalizeBody`
  inside `index.ts`), not the shared `internal/core.ts` one — the
  local version preserves `Blob`-vs-bytes distinctions Supabase cares
  about. Don't replace it without re-checking the Blob `contentType`
  override semantics.
- Forward `operationOpts.signal` via the trailing `FetchParameters`
  slot on `download` and `list` (the only two primitives that accept
  it). Other primitives have no signal slot — surfacing one without a
  way to propagate it would be misleading.
- Use `createStoredFile` from
  [`internal/stored-file.ts`](../internal/stored-file.ts) for every
  `StoredFile` you return. Don't hand-roll body accessors.
- `safeInfo` is the right escape hatch for any `info()` call where a
  failure shouldn't block the operation. Don't try-catch around
  `info()` ad-hoc; extend `safeInfo` instead.

## Releases

The repo uses Changesets. Behavioural changes here need a changeset
(`bunx changeset`); README / AGENTS.md edits don't. When a public type
in `SupabaseAdapterOptions` or `SupabaseAdapter` changes, also flag the
provider catalog entry in
[`../providers/index.ts`](../providers/index.ts) — env-var aliases and
peer deps are duplicated there for the discovery surface.

## Where to look next

- Source: [`./index.ts`](./index.ts); tests: [`../../test/supabase.test.ts`](../../test/supabase.test.ts).
- User-facing docs: [`apps/web/content/docs/adapters/supabase.mdx`](../../../../apps/web/content/docs/adapters/supabase.mdx).
- Provider catalog entry: [`../providers/index.ts`](../providers/index.ts) (search `slug: "supabase"`).
- Unified `Adapter` contract: [`../index.ts`](../index.ts).
- Shared helpers (URL strategy, error-mapper factory, delete-many
  fallback): [`../internal/core.ts`](../internal/core.ts).
- `FilesError`: [`../internal/errors.ts`](../internal/errors.ts); env reader: [`../internal/env.ts`](../internal/env.ts).
- Package SKILL: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md); README: [`../../README.md`](../../README.md).
