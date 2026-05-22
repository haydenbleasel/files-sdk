# AGENTS.md — `files-sdk/scaleway`

Guidance for coding agents working on the `scaleway` adapter. The unified
`Adapter<Raw>` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents scaleway-specific
behavior. `scaleway()` is a thin wrapper around [`s3()`](../s3/index.ts)
for Scaleway Object Storage's S3-compatible API, so the operation map,
error mapping, and presign mechanics all live in the S3 adapter — see
[`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level details.
Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with a Scaleway endpoint, Scaleway
credentials, and a `defaultProviderMessage` of `"Scaleway error"` so
callers don't see `"S3 error"` from a Scaleway-typed adapter. No
per-method code here: every operation is forwarded by spread. The only
scaleway-specific knobs are endpoint derivation from the region code, the
credential env-var pair (`SCW_ACCESS_KEY` / `SCW_SECRET_KEY`), and the
error-message relabel. The returned adapter's `raw` is the underlying
`@aws-sdk/client-s3` `S3Client` — anything the AWS SDK can do against
Scaleway (multipart, object lock, lifecycle) is one property access away.

## Directory layout

```text
packages/files-sdk/src/scaleway/
├── index.ts                   # scaleway() factory + ScalewayAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/scaleway.test.ts`](../../test/scaleway.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/scaleway.mdx`](../../../../apps/web/content/docs/adapters/scaleway.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/scaleway.test.ts   # adapter unit tests only
bun test                          # full SDK suite
bun run build                     # tsup → dist/, including dist/scaleway/
bun run types                     # tsgo --noEmit (typecheck only)
```

The `scaleway` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
entry in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `scaleway(opts: ScalewayAdapterOptions): ScalewayAdapter` — primary factory.
- `ScalewayAdapter` — type alias for `Adapter<S3Client>`; `raw` is the
  underlying AWS SDK client.
- `ScalewayAdapterOptions` — config interface (JSDoc on every field is
  the source of truth; the docs MDX pulls it via `AutoTypeTable`).

The adapter's `name` is `"scaleway"` — set after spreading the inner adapter so it overrides `"s3"`.

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- `region` — Scaleway region code: `fr-par` (Paris), `nl-ams`
  (Amsterdam), or `pl-waw` (Warsaw). **No env fallback** — missing region
  throws `FilesError("Provider", …)` at construction with the hint
  `'Pass `region` (e.g. "fr-par").'`. The region doubles as the SigV4
  region and drives the default endpoint host.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced
  from `SCW_ACCESS_KEY` / `SCW_SECRET_KEY`. Missing both throws
  `FilesError("Provider", …)`. Generate keys in the Scaleway console
  under *Identity and Access Management → API Keys*.

Optional:

- `endpoint` — overrides the derived `https://s3.${region}.scw.cloud`.
  Use for private endpoints, custom DNS, or test doubles. Scaleway routes
  by `Host` header — the SDK prepends the bucket subdomain in
  virtual-hosted mode.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical for
  Scaleway; flip only for proxies that demand path-style addressing.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value for public-read buckets is
  `https://${bucket}.s3.${region}.scw.cloud`; a custom domain fronting the
  bucket also works.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds;
  defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in [`../internal/core.ts`](../internal/core.ts).

No `SCW_REGION` or `SCW_BUCKET` env-var fallback. The provider catalog
entry in [`../providers/index.ts`](../providers/index.ts) (search
`slug: "scaleway"`) declares the same two credential env vars and treats
`bucket` / `region` as explicit config. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`scaleway()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. The implementations of
`upload`, `download`, `head`, `exists`, `delete`, `deleteMany`, `copy`,
`list`, `url`, and `signedUploadUrl` all live in
[`../s3/index.ts`](../s3/index.ts) and are inherited unchanged —
including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`' 404-as-`false`
classification. Provider errors flow through `mapS3Error` with the
Scaleway fallback table — `Provider`-coded messages read
`"Scaleway error"` instead of `"S3 error"` while preserving any
server-side message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds. Issued against
  `s3.<region>.scw.cloud`.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature in which
  to bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts) for the rationale.

Public-read buckets are reachable at
`https://<bucket>.s3.<region>.scw.cloud` — that's the natural
`publicBaseUrl` value. No built-in CDN; front with Scaleway Edge Services
or a third-party CDN if you need caching.

## Provider quirks worth remembering

- **Region drives the endpoint, with no env-var fallback.** Buckets live
  in exactly one of `fr-par`, `nl-ams`, or `pl-waw`, served from
  `s3.<region>.scw.cloud`. The `region` field is the only way in — there
  is no `SCW_REGION` shortcut, no cross-region replication primitive, and
  picking the wrong region fails SigV4 signing before the request reaches
  the bucket.
- **API keys, not IAM roles.** The S3-compatible API exposes only static
  access keys generated under *Identity and Access Management → API
  Keys*. No instance metadata, no role-assumption — passing
  `accessKeyId` / `secretAccessKey` (or the env-var pair) is the only
  auth mode.
- **No native CDN.** `publicBaseUrl` against the bucket's own
  `s3.<region>.scw.cloud` origin works for public-read buckets but won't
  give you caching. Use a custom domain only when a CDN fronts the bucket.
- **Virtual-hosted style is canonical.** Scaleway routes by Host header;
  `forcePathStyle: true` works but is rarely needed — leave it off unless
  a proxy demands path-style.

## Testing approach

Unit tests at [`../../test/scaleway.test.ts`](../../test/scaleway.test.ts)
cover:

- Endpoint derivation from `region` (`fr-par`, `nl-ams`).
- Explicit `endpoint` and `forcePathStyle` overrides reaching the inner
  `S3Client` config.
- Missing-region and missing-credential errors at construction.
- `SCW_ACCESS_KEY` / `SCW_SECRET_KEY` env-var fallbacks.
- `url()` presign default (with `X-Amz-Expires=3600` and the
  `s3.fr-par.scw.cloud` host) and the `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock`'s `mockClient(S3Client)`
  — proves `upload` and `exists` reach the underlying client.
- Error relabeling: `mapS3Error` invoked with the Scaleway messages table
  returns `"Scaleway error"` for `Provider`.

Add fixtures here rather than to `s3.test.ts` whenever a behavior depends
on the scaleway-specific config (endpoint host, relabel, env-var name);
shared S3 semantics belong in [`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `scaleway`, `ScalewayAdapter`,
  `ScalewayAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation errors
  are the inner S3 adapter's responsibility — don't try-catch and rethrow
  in this shim.
- Pick up environment variables via [`readEnv`](../internal/env.ts).
  Direct `process.env` access breaks Cloudflare Workers without
  `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to AWS-SDK defaults rather than being
  passed as explicit `undefined`. The current factory uses this pattern
  for `forcePathStyle`, `publicBaseUrl`, and `defaultUrlExpiresIn`.
- Spread the inner adapter, then override only `name` — preserves any
  future additions to the `Adapter` interface that `s3()` picks up
  automatically.
- Top-level regex literals only. The current file has none; keep it
  that way unless adding a real parser.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump the `files-sdk`
version and add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md);
docs / test-only additions don't. The `scaleway` subpath is already
declared in `exports` — no further wiring needed for new options.

## Where to look next

- Unified contract & `Adapter` interface: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) + [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers (URL strategy, body normalization, error-mapper factory): [`../internal/core.ts`](../internal/core.ts).
- `FilesError` and codes: [`../internal/errors.ts`](../internal/errors.ts).
- Env-var reader: [`../internal/env.ts`](../internal/env.ts).
- Provider catalog entry (search `slug: "scaleway"`): [`../providers/index.ts`](../providers/index.ts).
- User-facing docs: [`../../../../apps/web/content/docs/adapters/scaleway.mdx`](../../../../apps/web/content/docs/adapters/scaleway.mdx).
- Package README: [`../../README.md`](../../README.md).
- SKILL doc: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/scaleway.test.ts`](../../test/scaleway.test.ts).
