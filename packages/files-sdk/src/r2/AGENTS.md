# AGENTS.md — `files-sdk/r2`

Guidance for coding agents working inside the `files-sdk/r2` adapter
(the Cloudflare R2 entry point at the `files-sdk/r2` subpath). The
unified `Adapter` contract every method conforms to lives in
[`../index.ts`](../index.ts) — read it first. This file documents
r2-specific deviations only.

R2 is one of the most complex adapters because it ships **three**
distinct modes from the same factory: HTTP-only (S3-compatible API,
bundles the AWS SDK), binding-only (Workers `R2Bucket`, no AWS SDK at
all), and hybrid (binding plus HTTP credentials, so reads/writes stay
intra-Worker but `url()` and `signedUploadUrl()` can still mint
presigned URLs). For the user-facing surface, see
[`../../README.md`](../../README.md) and
[`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

`r2(opts)` returns an `Adapter<S3Client | R2Bucket>` whose shape is
identical to every other adapter in the SDK. The deviations are
entirely about how it dispatches behind that surface.

- **HTTP mode** — wraps [`../s3/index.ts`](../s3/index.ts) with
  Cloudflare-flavoured defaults (`region: "auto"`,
  `forcePathStyle: true`,
  `endpoint: https://{accountId}.r2.cloudflarestorage.com`,
  `defaultProviderMessage: "R2 error"`). Used outside Workers.
- **Binding mode** — implements every operation directly against the
  `R2Bucket` binding API. No AWS SDK, no HTTP round-trip, no egress
  fees. Used for binding-resident reads/writes inside a Worker.
- **Hybrid mode** — binding for reads/writes, lazy s3 adapter for
  `url()` and `signedUploadUrl()`. Triggered when `binding` plus
  `bucket` plus the three HTTP credentials (`accountId`,
  `accessKeyId`, `secretAccessKey`) are all present. Useful for
  Workers that need browser-facing presigned URLs without giving up
  the binding's I/O performance.

The factory branches on `"binding" in opts`; hybrid is recognised
inside the binding entry point by the *additional* presence of HTTP
credentials.

## Directory layout

```
packages/files-sdk/src/r2/
└── index.ts             # r2() factory + r2FromHttp + r2FromBinding + mapR2Error + lazyS3
```

Tests live in [`../../test/r2.test.ts`](../../test/r2.test.ts), the
user-facing docs page is
[`apps/web/content/docs/adapters/r2.mdx`](../../../../apps/web/content/docs/adapters/r2.mdx),
and the provider catalog entry lives in
[`../providers/index.ts`](../providers/index.ts) under `slug: "r2"`.

## Build, test, typecheck

```bash
bun test test/r2.test.ts   # just this adapter's suite
bun test                   # full package suite
bun run build              # tsup ESM bundle → dist/
bun run types              # tsgo --noEmit
```

Tests use **bun test** (not vitest); type-checking uses **tsgo
--noEmit**. Run both from `packages/files-sdk/` and keep them green
before opening a PR.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `r2(opts: R2AdapterOptions): R2Adapter` — the factory.
- `R2HttpOptions`, `R2BindingOptions` (encodes hybrid via optional
  HTTP credential fields), and the union
  `R2AdapterOptions = R2BindingOptions | R2HttpOptions`.
- `R2Adapter = Adapter<S3Client | R2Bucket>` — `.raw` is the
  underlying `S3Client` (HTTP/hybrid) or `R2Bucket` (binding-only).
- `R2Bucket` — re-exported from `@cloudflare/workers-types` so
  callers don't need a second import.

## Authentication / configuration

R2 has two credential modes (mirrored in
[`../providers/index.ts`](../providers/index.ts) under `r2.env`).

**HTTP mode (`R2HttpOptions`).** Required: `bucket`, `accountId`,
`accessKeyId`, `secretAccessKey`. The latter three fall back to
Cloudflare-specific env vars:

| Field                 | Env fallback             | Required?                              |
| --------------------- | ------------------------ | -------------------------------------- |
| `bucket`              | —                        | Yes                                    |
| `accountId`           | `R2_ACCOUNT_ID`          | Yes — constructor throws if missing    |
| `accessKeyId`         | `R2_ACCESS_KEY_ID`       | Yes — constructor throws if missing    |
| `secretAccessKey`     | `R2_SECRET_ACCESS_KEY`   | Yes — constructor throws if missing    |
| `publicBaseUrl`       | —                        | No — switches `url()` to unsigned      |
| `defaultUrlExpiresIn` | —                        | No — defaults to 3600 seconds          |

Env reads go through [`readEnv`](../internal/env.ts), which returns
`undefined` (rather than throwing `ReferenceError`) when `process` is
missing — important on Workers without `nodejs_compat`. If you change
the env-var names, update the provider catalog and user-facing docs
in lockstep.

**Binding mode (`R2BindingOptions`).** `binding: R2Bucket` is the only
required field. Optional fields:

- `publicBaseUrl?` — origin for `url()` to concatenate against.
  Without this *and* without hybrid credentials, `url()` throws
  `Provider` because a binding has no signing primitive.
- `bucket?` plus `accountId?` / `accessKeyId?` / `secretAccessKey?` —
  opt into hybrid mode. **All four** must be present to enable
  hybrid; partial sets silently degrade to plain binding mode.
- `defaultUrlExpiresIn?` — only consulted by the hybrid signing
  fallback.

**`defaultProviderMessage`.** Both HTTP and hybrid paths set the
(internal) s3 option `defaultProviderMessage: "R2 error"` so unknown
errors that bubble through the s3 mapper carry an R2-flavoured
message instead of the default `"S3 error"`. Callers should never
see an `"S3 error"` string from this adapter; the relabel is verified
by a dedicated test.

## Operation map

The HTTP path is a thin async wrapper over the s3 adapter — every
method does `const inner = await ensure(); return inner.<method>(…)`.
The binding path is implemented inline against the `R2Bucket` API:

| Method            | HTTP / hybrid                | Binding read/write path                                                              |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `upload`          | Inner `s3.upload`            | `bucket.put` after `normalizeForR2` shapes the body                                  |
| `download`        | Inner `s3.download`          | `bucket.get`; `null` → `NotFound`; honours `as: "stream"`                            |
| `head`            | Inner `s3.head`              | `bucket.head`; lazy body factory re-issues `bucket.get` on demand                    |
| `exists`          | Inner `s3.exists`            | `bucket.head() !== null`, with `mapR2Error` classification on thrown errors          |
| `delete`          | Inner `s3.delete`            | `bucket.delete`                                                                      |
| `deleteMany`      | Inner `s3.deleteMany`        | Falls back to `deleteManyWithFallback` (binding has no bulk primitive)               |
| `copy`            | Inner `s3.copy`              | Streamed `bucket.get` → `bucket.put` (no server-side copy — see "Provider quirks")   |
| `list`            | Inner `s3.list`              | `bucket.list`; per-item lazy bodies fetch via `bucket.get`                           |
| `url`             | See URL behavior below       | See URL behavior below                                                               |
| `signedUploadUrl` | Inner `s3.signedUploadUrl`   | Hybrid only; throws `Provider` with guidance when no HTTP creds are present          |

Body normalisation is local. `normalizeForR2` produces shapes the
`R2Bucket.put` typing accepts (`ArrayBuffer | ReadableStream<Uint8Array>
| string`), differing from the shared
[`normalizeBody`](../internal/core.ts) by preserving `ArrayBuffer`
directly rather than copying through `Uint8Array` — the Workers type
rejects raw `Uint8Array` without an explicit copy.

`mapR2Error` classifies binding errors by both `name`
(`R2NotFoundError`, `Forbidden`, …) **and** Cloudflare's numeric
`code`: 10002 → `NotFound`, 10004/10006 → `Unauthorized`, 10007 →
`Conflict`; anything else falls through to `Provider`. `FilesError`
instances pass through untouched. See the
[Workers R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
for the canonical code list.

## URL behavior

`url(key, opts?)` is the most mode-sensitive method. The full matrix:

| Mode         | `publicBaseUrl` | `responseContentDisposition` | Result                                                                          |
| ------------ | --------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| HTTP         | yes             | absent                        | `${publicBaseUrl}/${encoded key}` (unsigned, no network call)                   |
| HTTP         | yes             | present                       | Presigned `GetObject` URL with `ResponseContentDisposition` baked in            |
| HTTP         | no              | any                           | Presigned `GetObject` URL (default `expiresIn` 3600s)                           |
| Binding-only | yes             | absent                        | `${publicBaseUrl}/${encoded key}` (no signing performed)                        |
| Binding-only | yes             | present                       | **Throws `Provider`** — disposition needs signing; binding can't sign           |
| Binding-only | no              | any                           | **Throws `Provider`** with guidance to add `publicBaseUrl` or HTTP credentials  |
| Hybrid       | yes             | absent                        | `${publicBaseUrl}/${encoded key}` (cheaper than signing, no network)            |
| Hybrid       | yes             | present                       | Presigned URL via the lazy s3 signer (disposition forces signing)               |
| Hybrid       | no              | any                           | Presigned URL via the lazy s3 signer (`expiresIn` defaults to 3600s)            |

`signedUploadUrl(key, opts)` is simpler: HTTP and hybrid forward to
the inner s3 adapter (PUT URL when `maxSize` is omitted, presigned
POST when `maxSize` is set — see the contract on
[`../index.ts`](../index.ts)); binding-only throws `Provider` with
the same "needs HTTP credentials" guidance as `url()`.

The "disposition forces signing" rule is centrally codified by
`resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts),
but the binding/hybrid `url()` implements the precedence inline
because its three-state logic doesn't fit that helper's two-state
shape — match the same invariant when modifying it.

## Lazy s3 import

The s3 adapter is **not** statically imported. `lazyS3` returns a
memoised getter that does `await import("../s3/index.js")` on first
call. This matters because `@aws-sdk/client-s3` is large (~500 KB
minified) — a binding-only Worker that imports `files-sdk/r2` should
never need the AWS SDK in its bundle. Consequences:

- HTTP-mode `adapter.raw` is `undefined` until the first method call
  resolves the import (covered by a dedicated test).
- Hybrid mode only triggers the import the first time `url()` or
  `signedUploadUrl()` is called.

Do **not** add a top-level `import { s3 } from "../s3/index.js"`
here — bundlers won't tree-shake it back out for the binding-only
path because the s3 module has side effects via AWS SDK init.

## Provider quirks worth remembering

- **No server-side copy on bindings.** `R2Bucket` exposes no atomic
  copy primitive, so binding `copy()` does `bucket.get(from)` →
  `bucket.put(to, obj.body, …)`. The body is streamed through `put`
  rather than buffered (multi-GB copies would otherwise blow Worker
  memory limits). Source/destination are not atomic — concurrent
  mutations of `from` between the get and put are not detected.
  Hybrid mode's HTTP signer is *not* used for copy.
- **Binding `head()` body access is lazy.** The binding's `head` API
  returns metadata only, so the `StoredFile` we expose installs a
  factory that re-issues `bucket.get(key)` on demand. If the object
  vanished between `head` and body access, the factory returns empty
  bytes (matches the `StoredFile` contract — guarded by the
  "lazy body returns empty bytes" test). Same applies to `list()`
  items.
- **Error shape.** R2 binding errors are plain objects with `name` and
  numeric `code`, not subclasses of `Error`. `mapR2Error` reads both;
  canonical fixtures (`{ name: "R2NotFoundError" }`, `{ code: 10_004 }`,
  etc.) live in the test file. `FilesError` instances pass through
  unchanged so internal throws don't get rewrapped. `bucket.list`
  cursors are surfaced only when `truncated` is true — the adapter
  mirrors that.
- **`bucket` is required for hybrid signing.** A common pitfall is
  passing `accountId` + `accessKeyId` + `secretAccessKey` but
  forgetting `bucket`; the adapter silently degrades to plain binding
  mode and `url()` starts throwing.
- **`publicBaseUrl` URL-encodes path segments** via
  [`joinPublicUrl`](../internal/core.ts) — but that only handles
  URL-syntax encoding. Sanitising untrusted input is still on the
  caller, per the docstring on [`../index.ts`](../index.ts).

## Testing approach

[`../../test/r2.test.ts`](../../test/r2.test.ts) splits into two
top-level `describe` blocks:

- **HTTP path** — uses `aws-sdk-client-mock` to stub `S3Client`
  responses. Covers default endpoint shape
  (`acct.r2.cloudflarestorage.com`, region `auto`), env-var
  fallbacks, the `publicBaseUrl` short-circuit, lazy `raw`
  materialisation, and the `"R2 error"` relabel.
- **Workers binding path** — uses an in-memory `fakeBinding()` helper
  (a `Map`-backed shim that mimics
  `R2Bucket.{get,put,head,list,delete}`) and covers every binding
  method, `mapR2Error` classification (10002 / 10004 / 10007 /
  unknown), lazy body access on `head`/`list`, the
  no-publicBaseUrl + no-creds throw, the disposition override forcing
  signing, and full hybrid mode end-to-end.

When adding a feature, prefer extending `fakeBinding()` over
fabricating a new mock. The s3 path forwards to the inner adapter,
so HTTP coverage here should stick to r2-unique behaviours — let the
s3 suite cover the rest of the operation map.

## Coding conventions

- Named exports only — no default exports.
- The factory branches on `"binding" in opts`, not on a discriminator
  field. Don't introduce a `kind: "binding" | "http"` tag; the union
  is structural by design.
- Errors thrown to callers use [`FilesError`](../internal/errors.ts)
  with one of the four `FilesErrorCode` values. `mapR2Error` is the
  only place that translates raw binding errors — keep it that way.
- Workers types come from `@cloudflare/workers-types`. The factory
  accepts `R2Bucket` structurally, so callers without that dep can
  pass a duck-typed binding.
- Don't read `process.env` directly. Go through
  [`readEnv`](../internal/env.ts) so the binding-only path (which can
  run in `nodejs_compat`-less Workers) doesn't crash.
- Don't unify `normalizeForR2` with
  [`normalizeBody`](../internal/core.ts) without first verifying the
  binding still accepts every input shape — the two differ
  deliberately.

## Releases

Behaviour changes need a Changeset entry: `bun changeset` from the
repo root, pick `files-sdk`. Docs-only edits (this file,
[r2.mdx](../../../../apps/web/content/docs/adapters/r2.mdx),
[README](../../README.md)) don't need a changeset.

## Where to look next

- Unified `Adapter` contract: [`../index.ts`](../index.ts).
- Inner s3 adapter: [`../s3/index.ts`](../s3/index.ts).
- Shared helpers and `FilesError`:
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog:
  [`../providers/index.ts`](../providers/index.ts) under `slug: "r2"`.
- Tests: [`../../test/r2.test.ts`](../../test/r2.test.ts).
- User-facing docs:
  [`apps/web/content/docs/adapters/r2.mdx`](../../../../apps/web/content/docs/adapters/r2.mdx),
  package [README](../../README.md), high-level mental model in
  [`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
