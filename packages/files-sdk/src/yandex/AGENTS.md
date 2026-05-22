# AGENTS.md — `files-sdk/yandex`

Guidance for coding agents working on the `yandex` adapter. The unified
`Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents yandex-specific
behavior. `yandex()` is a thin wrapper around [`s3()`](../s3/index.ts)
for [Yandex Object Storage](https://yandex.cloud/en/services/storage)'s
S3-compatible API, so the operation map, error mapping, and presign
mechanics live in the S3 adapter — see
[`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level details. Cross-refs:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with Yandex's fixed global endpoint
(`https://storage.yandexcloud.net`), a SigV4 region default of
`"ru-central1"`, Yandex credentials, and a `defaultProviderMessage` of
`"Yandex Cloud error"` so callers don't see `"S3 error"` from a
Yandex-typed adapter. No per-method code; every operation is forwarded
by spreading the inner adapter. The only yandex-specific knobs are the
fixed endpoint, the region default, the credential env-var pair, and
the error-message relabel. The returned adapter's `raw` is the
underlying `@aws-sdk/client-s3` `S3Client` — anything the AWS SDK can
do against Yandex Object Storage (multipart, versioning, lifecycle
rules, static-website hosting) is one property access away.

## Directory layout

```text
packages/files-sdk/src/yandex/
├── index.ts                   # yandex() factory + YandexAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude Code re-export
```

Tests at [`../../test/yandex.test.ts`](../../test/yandex.test.ts); user-facing
docs at [`../../../../apps/web/content/docs/adapters/yandex.mdx`](../../../../apps/web/content/docs/adapters/yandex.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/yandex.test.ts   # adapter unit tests only
bun test                       # full SDK suite
bun run build                  # tsup → dist/, including dist/yandex/
bun run types                  # tsgo --noEmit (typecheck only)
```

The `yandex` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
entry in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `yandex(opts: YandexAdapterOptions): YandexAdapter` — primary factory.
- `YandexAdapter` — alias for `Adapter<S3Client>`. `raw` is the
  underlying AWS SDK client.
- `YandexAdapterOptions` — config interface (JSDoc on every field is
  the source of truth; the docs MDX pulls it via `AutoTypeTable`).

The adapter's `name` is `"yandex"`, set after spreading the inner
adapter so it overrides `"s3"`.

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced
  from `YANDEX_ACCESS_KEY_ID` / `YANDEX_SECRET_ACCESS_KEY`. Missing
  both throws `FilesError("Provider", …)` at construction. Generate
  static key pairs in the Yandex Cloud console for a service account
  with `storage.editor` (or `storage.viewer` for read-only bots).

Optional:

- `endpoint` — defaults to `https://storage.yandexcloud.net`. Yandex
  serves a single global endpoint and routes internally; only override
  for a private deployment, proxy, or test double.
- `region` — defaults to `"ru-central1"`. SigV4-only; the endpoint is
  fixed, so the label drives signing but never routing. Leave the
  default unless you have a reason to change it.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical
  for Yandex Object Storage.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value is `https://${bucket}.storage.yandexcloud.net`, or a
  custom CNAME bound to the bucket via the Yandex console.
- `defaultUrlExpiresIn` — presigned-URL expiry in seconds. Defaults to
  `3600` via `DEFAULT_URL_EXPIRES_IN`
  ([`../internal/core.ts`](../internal/core.ts)).

There is no `YANDEX_REGION`, `YANDEX_ENDPOINT`, or `YANDEX_BUCKET`
fallback. The provider catalog entry in
[`../providers/index.ts`](../providers/index.ts) (search
`slug: "yandex"`) declares the same two credential env vars and treats
`bucket` as explicit config — region is omitted because the adapter
defaults it. Env lookups go through [`readEnv`](../internal/env.ts) so
the adapter is safe on runtimes without `process` (Cloudflare Workers
without `nodejs_compat`).

## Operation map

`yandex()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. `upload`, `download`,
`head`, `exists`, `delete`, `deleteMany`, `copy`, `list`, `url`, and
`signedUploadUrl` all live in [`../s3/index.ts`](../s3/index.ts) and
are inherited unchanged — including `deleteMany`'s 1000-key chunking,
`signedUploadUrl`'s PUT-vs-presigned-POST split on `maxSize`, and
`exists`' 404-as-`false` classification. Provider errors flow through
`mapS3Error` with the Yandex fallback table — `Provider`-coded
messages read `"Yandex Cloud error"` while preserving any server-side
message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds. Host is always
  `storage.yandexcloud.net` (or your override).
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature in
  which to bind the override, and silently dropping it would be a
  stored-XSS regression on user-uploaded HTML/SVG. See
  `resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts).

Yandex has no built-in CDN, so most configurations leave `publicBaseUrl`
unset and sign every read.

## Provider quirks worth remembering

- **Single global endpoint.** Unlike Wasabi, Scaleway, or OVH, Yandex
  serves all traffic from `storage.yandexcloud.net` and routes
  internally. `region` is signing-only — overriding it does not change
  the host, and `test/yandex.test.ts` pins this invariant.
- **`ru-central1` is the only public signing region today.** The
  default works for every bucket in the public service; only override
  for a private deployment with a different SigV4 label.
- **Service-account static keys, no IAM-role analog.** Generate static
  access keys for a service account in the Yandex Cloud console — the
  S3-compatible API has no short-lived instance-metadata path.
- **Russia-regulated service.** Data lives in Russian datacenters;
  weigh data-residency and sanctions exposure before pointing user
  data here. Worth flagging when reviewing the adapter choice.
- **Custom domains for public reads.** Yandex lets you bind a CNAME to
  a public bucket. When configured, set `publicBaseUrl` to the custom
  origin and `url()` will skip signing.

## Testing approach

Unit tests at [`../../test/yandex.test.ts`](../../test/yandex.test.ts)
cover:

- Defaults: `storage.yandexcloud.net` over `https:`, `ru-central1`
  region, `forcePathStyle: false`.
- Region override flows to the inner `S3Client` without changing the
  endpoint host; `endpoint` and `forcePathStyle: true` overrides reach
  the inner client.
- Missing-credential error at construction; `YANDEX_ACCESS_KEY_ID` /
  `YANDEX_SECRET_ACCESS_KEY` env-var fallbacks.
- `url()` presign default (signature present, `X-Amz-Expires=3600`,
  host = `storage.yandexcloud.net`) and `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock`'s
  `mockClient(S3Client)` — `upload` and `exists` reach the underlying
  client and `exists` returns `false` on a 404.
- Error relabeling: `mapS3Error` with the Yandex messages table
  returns `"Yandex Cloud error"` for `Provider`.

Add fixtures here for yandex-specific config (fixed endpoint,
`ru-central1` default, relabel, env-var names); shared S3 semantics
belong in [`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `yandex`, `YandexAdapter`, `YandexAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  and rethrow here.
- Read env vars via [`readEnv`](../internal/env.ts); direct `process.env`
  breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with
  `...(opts.x !== undefined && { x: opts.x })` so unset values fall
  through to AWS-SDK defaults instead of being passed as explicit
  `undefined`.
- Spread the inner adapter, then override only `name` — future
  additions to the `Adapter` interface that `s3()` picks up are
  inherited automatically. Top-level regex literals only.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump `files-sdk` and
add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md); docs /
test-only additions don't. The `yandex` subpath is already declared
in `exports`.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts),
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "yandex"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/yandex.mdx`](../../../../apps/web/content/docs/adapters/yandex.mdx).
- README, SKILL, tests: [`../../README.md`](../../README.md),
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md),
  [`../../test/yandex.test.ts`](../../test/yandex.test.ts).
