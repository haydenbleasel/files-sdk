# AGENTS.md — `files-sdk/vercel-blob`

Guidance for coding agents working on the `vercel-blob` adapter
([Vercel Blob](https://vercel.com/storage/blob), exposed at the
`files-sdk/vercel-blob` subpath). The unified `Adapter<Raw>` contract
every method conforms to lives in [`../index.ts`](../index.ts); read it
first. This file documents only vercel-blob-specific deviations.
Cross-references: [`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

This is a **native** adapter — no inner `s3()` shim, no AWS SDK. Every
operation is implemented directly against `@vercel/blob`'s top-level
namespace (`blob.put`, `blob.head`, `blob.get`, `blob.list`, `blob.del`,
`blob.copy`). Two axes interact with `url()`, `download()`, and the
storeId fast path in non-obvious ways: public vs private blobs
(`access`) and OIDC vs read-write-token authentication.

`vercelBlob(opts)` returns an `Adapter<typeof blob>`. `raw` is the
`@vercel/blob` namespace itself, so the escape hatch is the entire SDK
(`files.raw.handleUpload(...)`, `files.raw.list({ mode: "folded" })`,
etc.). The factory resolves credentials at construction time, captures
the chosen access mode, and threads everything through a shared
`BlobAuthOptions` object spread into every `blob.*` call site.
Construction fails fast on misconfiguration so anonymous calls that
401 at runtime are impossible to reach.

Peer dep:
[`@vercel/blob`](https://www.npmjs.com/package/@vercel/blob), pinned at
`^2.4.0` in [`../../package.json`](../../package.json) — the first
version that ships the OIDC options. Shared plumbing lives in
[`../internal/`](../internal/) (`core.ts`, `stored-file.ts`,
`errors.ts`, `env.ts`).

## Directory layout

```text
packages/files-sdk/src/vercel-blob/
├── index.ts          # vercelBlob() factory + VercelBlobAdapterOptions
├── AGENTS.md         # this file
└── CLAUDE.md         # `@AGENTS.md` — Claude-Code re-export
```

Sibling files: tests at
[`../../test/vercel-blob.test.ts`](../../test/vercel-blob.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/vercel-blob.mdx`](../../../../apps/web/content/docs/adapters/vercel-blob.mdx);
subpath export at `exports["./vercel-blob"]` in
[`../../package.json`](../../package.json).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/vercel-blob.test.ts   # this adapter only
bun test                             # full SDK suite
bun run build                        # tsup ESM → dist/vercel-blob/
bun run types                        # tsgo --noEmit
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`); both are pinned in [`../../package.json`](../../package.json).

## Public surface

Exports from [`./index.ts`](./index.ts):

- `vercelBlob(opts?: VercelBlobAdapterOptions): VercelBlobAdapter` —
  primary factory. `opts` is typed as optional, but in practice you
  must either set credentials env vars or pass them explicitly; an
  unconfigured factory throws at construction.
- `VercelBlobAdapter = Adapter<VercelBlobClient>` where
  `VercelBlobClient = typeof blob`. `raw` is the `@vercel/blob`
  namespace, so callers reach for `files.raw.put(...)`,
  `files.raw.handleUpload(...)`, etc. for features outside the unified
  API.
- `VercelBlobAdapterOptions` — JSDoc on every field is the source of
  truth; the docs MDX pulls it via `AutoTypeTable`.

The adapter's `name` is `"vercel-blob"`.

## Authentication / configuration

Credential resolution mirrors the upstream `@vercel/blob` SDK so
callers can swap between the two without surprises (see `vercelBlob()`
body, ~lines 244-274 of [`./index.ts`](./index.ts)):

1. Explicit `opts.token` (read-write or client token) — wins over OIDC.
2. OIDC: `oidcToken` + `storeId` (option or env). **Both** must resolve.
3. Explicit `opts.oidcToken` with no resolvable `storeId` → throws. A
   caller who passed `oidcToken` is asking for OIDC; we refuse to
   silently swap to `BLOB_READ_WRITE_TOKEN`.
4. `BLOB_READ_WRITE_TOKEN` env var.
5. Anything else throws `FilesError("Provider", …)` at construction.

Env vars (read via [`readEnv`](../internal/env.ts), so the adapter is
safe to import on runtimes without `process` — Workers without
`nodejs_compat`, etc.):

| Var                     | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `BLOB_READ_WRITE_TOKEN` | Long-lived RW token. Fallback when no OIDC config is found.           |
| `VERCEL_OIDC_TOKEN`     | Vercel OIDC token. Auto-injected on Vercel deployments.               |
| `BLOB_STORE_ID`         | Store id. Accepted as `store_<id>` or `<id>`; the prefix is stripped. |

OIDC is the **recommended** mode on Vercel: tokens rotate automatically
so a static secret can't leak from the codebase or environment. Off
Vercel (or in frameworks like Vite that don't load `.env.local` into
`process.env`), pass `oidcToken` and `storeId` explicitly — the adapter
would otherwise silently fall back to the RW token.

`access: "public" | "private"` (defaults to `"public"`) is fixed at
construction; a single `Files` instance is unambiguously one mode or
the other. If you need both, instantiate two adapters.

Other knobs (full JSDoc on the option interface):

- `addRandomSuffix` — defaults to `false`, **diverging from Vercel's
  own default of `true`**. Predictable keys are the dominant SDK
  assumption; the upstream default would silently mangle caller-supplied
  pathnames.
- `allowOverwrite` — defaults to `true` so predictable keys actually
  work (Vercel rejects same-pathname uploads otherwise). Trade-off:
  `upload(key, …)` clobbers any existing object at `key`. Set to
  `false` for create-only semantics and handle the resulting `Conflict`.
- `downloadTimeoutMs` — bounds public-URL fetches and lazy bodies from
  `head()` / `list()`. Defaults to 300 000 ms (5 minutes); pass `0` to
  disable.

## Operation map

Every method spreads `BlobAuthOptions` (`{ token }` or
`{ oidcToken, storeId }`) into the underlying call. Errors flow
through `mapBlobError`, which classifies on HTTP status first
(`404 → NotFound`, `401/403 → Unauthorized`, `409/412 → Conflict`,
otherwise `Provider`) and falls back to error-name substring matching
when the underlying fetch error doesn't surface a status — `name`
matching catches `BlobNotFoundError` and friends even when the
transport doesn't carry an HTTP status.

| Method            | Implementation                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload`          | `blob.put(key, body, …)` with `access`, `addRandomSuffix`, `allowOverwrite`, `contentType`, `cacheControlMaxAge` parsed from `opts.cacheControl`.                                    |
| `download`        | Public: `blob.head` + `fetch(url)` with timeout. Private: `blob.head` + `blob.get(key, { access: "private", … })` for an authenticated stream.                                       |
| `head`            | `blob.head(key, …)` → `createStoredFile`. Maps `pathname → key`, `contentType → type` (default `application/octet-stream`), `uploadedAt.getTime() → lastModified`, `etag`, `size`.   |
| `exists`          | `existsByProbe(blob.head, mapBlobError)`. `NotFound` → `false`; everything else propagates.                                                                                          |
| `delete`          | `blob.del(key, …)`.                                                                                                                                                                  |
| `copy`            | `blob.copy(from, to, …)` with `access`, `addRandomSuffix`, `allowOverwrite`. Server-side, no body transfer.                                                                          |
| `list`            | `blob.list({ prefix, limit, cursor, … })`. The `cursor` field is opaque — pass `result.cursor` back unmodified on the next page. Each item gets a lazy body factory that mirrors `head`. |
| `url`             | See [URL behavior](#url-behavior).                                                                                                                                                   |
| `signedUploadUrl` | **Throws `Provider`.** Vercel Blob has no presigned-upload primitive — browser uploads go through `handleUpload()` from `@vercel/blob/client`.                                       |

A few non-obvious behaviours called out by tests:

- **Stream uploads do a follow-up `blob.head`.** `blob.put`'s response
  has no `size`, and stream bodies have no upfront length, so the
  adapter consults `head` for authoritative `size` and `lastModified`.
  Known-size bodies (`string`, `Uint8Array`, `ArrayBuffer`,
  `ArrayBufferView`, `Blob`) skip the extra round trip.
- **`download` always issues a `blob.head` first** to populate metadata;
  only then is the body fetched (public path) or streamed (private path).
- **Private downloads never touch `fetch()`.** Lazy bodies on private
  `head()` / `list()` results route through `blob.get`, so a
  misconfigured public URL can't leak unauthenticated 401s. Public-path
  lazy bodies also honour `downloadTimeoutMs` so a hung CDN can't pin
  the whole call.

## URL behavior

`url(key, opts?)` is the most adapter-specific method:

- **Private blobs always throw `Provider`.** The `url` field that
  `blob.head` / `blob.list` return for private blobs requires
  authentication to fetch — handing it out from `url()` would silently
  break the "permanent public URL" contract by returning links that
  always 401. Use `download()` instead. The private check runs *before*
  the storeId fast path, so a `vercel_blob_rw_<id>_…` token can't
  override it.
- **`opts.responseContentDisposition` always throws `Provider`** (public
  *and* private). Vercel Blob has no signing primitive, so there is no
  way to bind a `Content-Disposition` override. Silently dropping it
  would be a stored-XSS regression on user-uploaded HTML or scripted
  SVG (see `UrlOptions` in [`../index.ts`](../index.ts)). The error
  message points to using a different provider for untrusted content.
- **`opts.expiresIn` is ignored** on public blobs. The CDN URL is
  permanent — there is no signing mechanism in which to encode an
  expiry.
- **StoreId fast path.** When a `storeId` is known (option,
  `BLOB_STORE_ID` env, or derived from a `vercel_blob_rw_<id>_…` token)
  **and** `addRandomSuffix` is `false`, `url()` synthesises
  `https://<storeId>.public.blob.vercel-storage.com/<encoded-key>` via
  [`joinPublicUrl`](../internal/core.ts) without any network call. Keys
  are URL-encoded segment-by-segment; pass them raw.
- **Fallback path.** When the fast-path conditions don't hold, `url()`
  falls back to `blob.head(key)` and returns `result.url`; missing
  `url` throws `Provider`.

The token parser (`deriveStoreIdFromToken`) is intentionally
conservative: it requires the exact `vercel_blob_rw_` prefix and an
alphanumeric segment of ≥8 characters. If Vercel ever inserts a
version segment (`vercel_blob_rw_v2_<id>_…`), shortens the storeId, or
changes the separator, the candidate fails the shape check and the
adapter falls back to `head()` — never to a URL pointing at someone
else's store. Both regressions have dedicated tests.

## Provider quirks worth remembering

- **No metadata primitive.** `UploadOptions.metadata` is silently
  dropped; `head()` / `list()` return `metadata: undefined` regardless
  of what was passed at upload time. Caveat is documented on
  `UploadOptions` in [`../index.ts`](../index.ts).
- **No object-level `cacheControl` string.** `blob.put` only accepts a
  numeric `cacheControlMaxAge`. The adapter parses `max-age=<n>` out of
  the caller-supplied string and forwards just the number; the rest
  (`public`, `s-maxage`, `stale-while-revalidate`, …) is dropped
  silently. For full control, configure caching on the store itself.
- **`signedUploadUrl()` throws by design.** Client-side uploads go
  through `handleUpload()` from `@vercel/blob/client` — that package
  implements the upload-token mechanism. Don't fake it with a PUT URL;
  Vercel doesn't accept anonymous PUTs against the blob host.
- **`addRandomSuffix` flips the upstream default.** Vercel ships `true`;
  the adapter defaults to `false` so `upload(key, …)` keeps the
  caller-supplied pathname. Under OIDC, `BLOB_STORE_ID` is the way to
  opt into the URL fast path — the token parser refuses to guess from
  unfamiliar token shapes.
- **Private `blob.get` may resolve to `null` or a non-200 `statusCode`.**
  Both are treated as `NotFound` so we never hand back a `StoredFile`
  with a null stream — guarded by a dedicated test.

## Testing approach

Tests in [`../../test/vercel-blob.test.ts`](../../test/vercel-blob.test.ts)
mock `@vercel/blob` directly via `mock.module(...)`, then dynamically
import the adapter so the mocked module is in scope. Coverage areas:

- Construction-time credential resolution: missing creds, partial OIDC
  env, explicit `oidcToken` without `storeId`, explicit `token` beating
  OIDC, OIDC env beating `BLOB_READ_WRITE_TOKEN`.
- Operation delegation: every call site (`put`, `head`, `del`, `copy`,
  `list`, `get`) passes auth options through and forwards `abortSignal`.
- URL synthesis: storeId fast path with predictable keys, special-char
  encoding, and all four fallbacks (unfamiliar token shape,
  `addRandomSuffix: true`, `store_<id>` form, no derivable id).
- Private mode: `access` propagates to `put` / `copy`, body reads route
  through `blob.get`, `url()` throws even when the storeId fast path
  would otherwise apply, `download` maps `null` / `404` / `403`
  correctly.
- Error surfaces: `signedUploadUrl` mentions `handleUpload`,
  `responseContentDisposition` throws with a security-rationale
  message, upload errors classify by HTTP status, name-based fallback
  for `BlobNotFoundError`. Timeout: `download` passes an `AbortSignal`
  derived from `downloadTimeoutMs`; `downloadTimeoutMs: 0` disables it.

The fetch mock routes URLs containing `/missing` to a 404 — useful for
forcing the public-fetch path to fail without breaking the `head()`
mock. The `beforeEach` block clears `VERCEL_OIDC_TOKEN` /
`BLOB_STORE_ID` from `process.env` so RW-token tests don't pick them
up from the host shell.

## Coding conventions

- Named exports only — `vercelBlob`, `VercelBlobAdapter`,
  `VercelBlobAdapterOptions`, `VercelBlobClient`. No default exports.
- Wrap every `blob.*` call in try/catch that funnels through
  `mapBlobError`. `FilesError` instances pass through unchanged.
- Pick up env vars via [`readEnv`](../internal/env.ts). Direct
  `process.env` access breaks Workers without `nodejs_compat`.
- Use `createStoredFile` from
  [`../internal/stored-file.ts`](../internal/stored-file.ts) for every
  `StoredFile`. The lazy-body factory is the only place you should be
  deciding between `fetch` and `blob.get`.
- Forward `operationOpts.signal` to the SDK as
  `{ abortSignal: signal }`. The download path uses
  `withTimeoutSignal` to merge it with the configured timeout — keep
  that helper local to this file.
- Top-level regex literals only. `STORE_ID_RE` is the existing pattern;
  follow the same shape if you add others.
- Don't expand the URL fast path to `addRandomSuffix: true` — the
  pathname is unknowable in advance, so any synthesised URL would
  point at a different object.

## Releases

The repo uses Changesets. Behavioural changes need a changeset
(`bunx changeset`, then commit under `.changeset/`). The
[`vercel-blob-oidc.md`](../../../../.changeset/vercel-blob-oidc.md)
entry is a good template for credential-resolution changes — it
documents the new env vars, the resolution order, the peer dep floor
bump, and the URL fast-path behaviour in one paragraph. Pure docs /
test changes don't need a changeset. The `vercel-blob` subpath is
already declared in [`../../package.json`](../../package.json) — no
further wiring needed for new options.

## Where to look next

- Source: [`./index.ts`](./index.ts); tests:
  [`../../test/vercel-blob.test.ts`](../../test/vercel-blob.test.ts).
- Unified contract: [`../index.ts`](../index.ts); shared helpers in
  [`../internal/`](../internal/).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/vercel-blob.mdx`](../../../../apps/web/content/docs/adapters/vercel-blob.mdx).
- Provider catalog (search `slug: "vercel-blob"`):
  [`../providers/index.ts`](../providers/index.ts).
- README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md);
  OIDC changeset:
  [`../../../../.changeset/vercel-blob-oidc.md`](../../../../.changeset/vercel-blob-oidc.md);
  upstream: [`@vercel/blob`](https://www.npmjs.com/package/@vercel/blob).
