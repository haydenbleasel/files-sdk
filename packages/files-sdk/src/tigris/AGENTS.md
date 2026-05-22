# AGENTS.md — `files-sdk/tigris`

Guidance for coding agents working on the `tigris` adapter. The unified
`Adapter<Raw>` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the tigris-specific
deviations. `tigris()` is a thin wrapper around [`s3()`](../s3/index.ts) for
[Tigris Data](https://www.tigrisdata.com)'s globally-distributed S3-compatible
API, so the operation map, presign mechanics, and error mapping live in the
S3 adapter — see [`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level
details. Cross-references: [`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with the Tigris global endpoint, Tigris
credentials, an `"auto"` SigV4 region default, and a `defaultProviderMessage`
of `"Tigris error"` so callers don't see `"S3 error"` from a Tigris-typed
adapter. No per-method code: every operation is forwarded by spread. Three
things differ from a raw `s3({ ... })` call:

- The endpoint defaults to a **single global host**
  `https://fly.storage.tigris.dev` — Tigris is a globally-distributed object
  store and routes each request to the nearest region automatically. No
  region-derived hostname to compute.
- `region` defaults to `"auto"` (not `us-east-1`). SigV4 requires *some*
  region for signing, but Tigris ignores it for routing.
- `forcePathStyle` defaults to `false` — virtual-hosted
  (`<bucket>.fly.storage.tigris.dev`) is canonical and matches the AWS SDK's
  own default.

Everything else — body normalization, presigned uploads, `deleteMany`
chunking, error classification, `publicBaseUrl`-vs-sign precedence — is s3
adapter behavior. `raw` is the underlying `S3Client`; any AWS SDK feature
against Tigris is one property access away.

## Directory layout

```text
packages/files-sdk/src/tigris/
├── AGENTS.md   # this file
├── CLAUDE.md   # @AGENTS.md indirection
└── index.ts    # tigris() factory + TigrisAdapterOptions
```

Tests: [`../../test/tigris.test.ts`](../../test/tigris.test.ts). User docs:
[`../../../../apps/web/content/docs/adapters/tigris.mdx`](../../../../apps/web/content/docs/adapters/tigris.mdx). Provider catalog:
[`../providers/index.ts`](../providers/index.ts) under `slug: "tigris"`.

## Build, test, typecheck

```bash
# from packages/files-sdk
bun test test/tigris.test.ts   # focused tigris suite (fast inner loop)
bun test                        # full package suite
bun run build                   # tsup ESM bundle → dist/, including dist/tigris/
bun run types                   # tsgo --noEmit (typecheck only)
```

The `tigris` subpath is in [`../../package.json`](../../package.json)'s
`exports` map — keep it in sync if the file layout changes. Changes to
[`../s3/index.ts`](../s3/index.ts) ripple here; run the full suite before
pushing s3-adjacent edits.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `tigris(opts: TigrisAdapterOptions): TigrisAdapter` — primary factory.
  Throws `FilesError("Provider", "tigris adapter: missing credentials…")`
  when neither option nor env var supplies the access-key pair. Returned
  adapter sets `name: "tigris"`, overriding the inner s3 adapter's `"s3"`.
- `TigrisAdapter` — type alias for `Adapter<S3Client>`. `.raw` is the
  underlying AWS SDK client.
- `TigrisAdapterOptions` — config interface. JSDoc on every field is the
  source of truth; the docs MDX pulls it via `<AutoTypeTable>`, so keep
  those comments user-facing.

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced from
  `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY`. Missing both throws
  `FilesError("Provider", …)` at construction.

Optional:

- `endpoint` — overrides `https://fly.storage.tigris.dev`. Use for
  pinned-region testing, a private deployment, or a test double.
- `region` — defaults to `"auto"`. Used only for SigV4 signing; Tigris routes
  globally and ignores it. Unusual among S3-compatible adapters (wasabi,
  backblaze-b2, storj, hetzner, akamai, digitalocean-spaces all require
  one) — the single global endpoint makes region a pure signing ritual, so
  the factory leaves it optional. The catalog row in
  [`../providers/index.ts`](../providers/index.ts) likewise lists only
  `bucket` in `config`.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical; flip
  only for proxies that demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing. Natural
  value for a public-read bucket is `https://${bucket}.fly.storage.tigris.dev`,
  or a custom domain bound to the bucket.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds. Defaults
  to `3600` via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

## Operation map

`tigris()` calls `s3()` with the resolved config and spreads the returned
adapter, overriding only `name`. `upload`, `download`, `head`, `exists`,
`delete`, `deleteMany`, `copy`, `list`, `url`, and `signedUploadUrl` all live
in [`../s3/index.ts`](../s3/index.ts) and are inherited unchanged — including
`deleteMany`'s 1000-key chunking, `signedUploadUrl`'s PUT-vs-presigned-POST
split on `maxSize`, `exists`' 404-as-`false` classification, and the
streaming-upload follow-up `HeadObject`. Provider errors flow through
`mapS3Error` with the Tigris fallback table — `Provider`-coded messages read
`"Tigris error"` instead of `"S3 error"` while preserving any server-side
message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules
(`resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts)):

- **No `publicBaseUrl`** → presigned `GetObject` against the global endpoint,
  signed with SigV4 against the configured (or `"auto"`) region, expiring
  after `opts.expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.
- **`publicBaseUrl` set** → unsigned concat `${publicBaseUrl}/${key}` via
  `joinPublicUrl` (URL-encodes path segments).
- **`opts.responseContentDisposition` set** → always forces signing, even
  when `publicBaseUrl` is configured. A permanent CDN URL has no signature
  to bind the override to, and dropping it silently would be a stored-XSS
  regression on user-uploaded HTML/SVG. Invariant lives in
  `resolveUrlStrategy`, not here.

## Provider quirks worth remembering

- **Regionless by design.** Tigris exposes one global hostname and routes
  each request to the nearest region. The `region` knob is purely a SigV4
  ritual — picking the "wrong" one doesn't fail signing the way it does on
  AWS or Wasabi, because Tigris doesn't bind buckets to regions in the
  signing path.
- **Endpoint origins.** Tigris started life as a Fly.io storage product,
  which is why the canonical host is `fly.storage.tigris.dev` and bucket
  subdomains read `<bucket>.fly.storage.tigris.dev`.
- **Access keys** are generated in the Tigris console or via the Fly CLI
  (`fly storage create`). Both flows produce the same S3-style `accessKeyId`
  / `secretAccessKey` the AWS SDK expects.
- **Errors are relabeled, not reclassified.** Status codes still map through
  `S3_NOT_FOUND_CODES` / `S3_UNAUTH_CODES` / `S3_CONFLICT_CODES` in
  [`../s3/index.ts`](../s3/index.ts); only the unknown-error fallback
  changes to `"Tigris error"`. Tests pin the relabel — update the assertion
  when the wording changes.

## Testing approach

Unit tests at [`../../test/tigris.test.ts`](../../test/tigris.test.ts) cover
the adapter's narrow surface:

- Default-config plumbing — global endpoint, `"auto"` region,
  `forcePathStyle: false` — read off the inner `S3Client`'s resolved config.
- `region` and `endpoint` overrides flow through to the inner client (and
  the endpoint stays unchanged when only `region` is overridden, proving
  region doesn't drive the host); `forcePathStyle: true` pass-through.
- Missing-credentials throw at construction and `TIGRIS_ACCESS_KEY_ID` /
  `TIGRIS_SECRET_ACCESS_KEY` env-var fallback.
- `url()` returns a presigned GET (`X-Amz-Signature=…`, `X-Amz-Expires=3600`,
  host `fly.storage.tigris.dev`) by default, and switches to unsigned concat
  when `publicBaseUrl` is set.
- `Files` integration via `aws-sdk-client-mock` — `upload` and `exists`
  exercise `PutObjectCommand` and `HeadObjectCommand` like raw s3.
- `mapS3Error` invoked directly with the tigris messages table to confirm
  the `Provider` fallback says `"Tigris error"`.

Add fixtures here whenever behavior depends on tigris-specific config
(global endpoint, `"auto"` region, env-var name, relabel); shared S3
semantics belong in [`../../test/s3.test.ts`](../../test/s3.test.ts). Mock
the SDK and reset between assertions; never hit real Tigris.

## Coding conventions

- Named exports only — `tigris`, `TigrisAdapter`, `TigrisAdapterOptions`.
- The factory is pure: no module-level state, no I/O at import. Env reads
  happen inside the factory via `readEnv`
  ([`../internal/env.ts`](../internal/env.ts)) so Cloudflare Workers (no
  `process`) can still import the module. Construction-time errors throw
  [`FilesError("Provider", "tigris adapter: …")`](../internal/errors.ts) so
  sibling S3-compatible adapters stay distinguishable in logs.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to the s3 default. Spread the inner adapter
  and override only `name` — preserves future additions to the `Adapter`
  interface.
- Type-only imports from `@aws-sdk/client-s3` (**optional** peer dep, see
  [`../../package.json`](../../package.json)); the runtime client is
  constructed inside `s3()`.

## Releases

Ships as `files-sdk` on a single version line via the repo-wide Changesets
schedule. Behavioral changes — default endpoint or region,
`defaultProviderMessage` text, env-var names, option renames — need a
changeset (`bun changeset`); tigris-specific bug fixes are patches.
AGENTS.md, CLAUDE.md, and docs-only edits don't. The `tigris` subpath is
already declared in `exports`.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner s3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "tigris"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/tigris.mdx`](../../../../apps/web/content/docs/adapters/tigris.mdx).
- Package README + SKILL: [`../../README.md`](../../README.md),
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
