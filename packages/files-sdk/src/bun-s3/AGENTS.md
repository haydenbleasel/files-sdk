# AGENTS.md — `files-sdk/bun-s3`

Guidance for coding agents working inside the `bun-s3` adapter. Every files-sdk adapter implements the same unified `Adapter<Raw>` contract from [`../index.ts`](../index.ts); this file only documents what is specific to `bun-s3`. Read [`README.md`](../../README.md) for the user-facing surface and [`SKILL.md`](../../../../skills/files-sdk/SKILL.md) for the cross-adapter mental model first. The sibling AWS-SDK adapter at [`../s3/index.ts`](../s3/index.ts) is a separate implementation, not a parent — they share no code, target different runtimes, and use different underlying SDKs.

## Overview

`bun-s3` talks to S3 (and any S3-compatible bucket) through Bun's native `Bun.S3Client` instead of `@aws-sdk/client-s3`. It is **Bun-only** — the factory throws at construction on Node, Workers, or any runtime where `globalThis.Bun.S3Client` is missing. The trade-off: a single-file adapter with zero peer dependencies that piggy-backs on Bun's built-in S3 implementation, at the cost of a few primitives that Bun's API does not expose (server-side copy, presigned POST forms with size policy, per-object cache and metadata headers).

The intended audience is users whose entire stack runs on Bun — for them, the `@aws-sdk/client-s3` install (≈3 MB across `client-s3`, `s3-presigned-post`, and `s3-request-presigner`) is pure overhead because Bun ships its own implementation. When any of the missing primitives are non-negotiable on a given bucket, the right answer is to point a parallel `s3()` adapter at it from a Node process and keep `bun-s3` for the Bun-side workloads.

`endpoint` and `virtualHostedStyle` are the knobs for non-AWS S3-compatible providers (Cloudflare R2, DigitalOcean Spaces, MinIO, Wasabi, Backblaze B2, …). Bun's S3 client speaks the same wire protocol; if a bucket works against AWS, it works against this adapter with the same options shape.

## Directory layout

```text
packages/files-sdk/src/bun-s3/
├── AGENTS.md          # this file
├── CLAUDE.md          # `@AGENTS.md` shim
└── index.ts           # adapter, types, and `mapBunS3Error`
```

Tests live one level up at [`../../test/bun-s3.test.ts`](../../test/bun-s3.test.ts) (the package keeps tests in a sibling `test/` tree, not colocated). The provider catalog entry sits at [`../providers/index.ts`](../providers/index.ts) under `slug: "bun-s3"`.

## Build, test, typecheck

```bash
bun test test/bun-s3.test.ts   # this adapter's tests only
bun test                        # the whole files-sdk test suite
bun run build                   # tsup ESM bundle → dist/bun-s3/
bun run types                   # tsgo --noEmit (typecheck)
bun run test:coverage           # bun test --coverage
```

Note: the package uses **`bun test`** (not Vitest) and **`tsgo`** (the TypeScript native preview, not `tsc`). Don't introduce Vitest configs or `tsc` invocations here.

## Public surface

`index.ts` exports:

- `bunS3(opts?)` — adapter factory. Returns `BunS3Adapter`.
- `BunS3Adapter` — `Adapter<BunS3ClientLike> & { readonly bucket?: string }`.
- `BunS3AdapterOptions` — construction options.
- `mapBunS3Error(err)` — error mapper, exposed for callers that drop into `files.raw` and want to translate provider errors back into `FilesError`.
- `BunS3ClientLike`, `BunS3FileLike`, `BunS3OperationOptions`, `BunS3PresignOptions`, `BunS3Stats`, `BunS3WritableBody`, `BunS3ListObjectsOptions`, `BunS3ListObjectsResponse` — the duck-typed `Bun.S3Client` surface area, exported so tests and host apps can implement compatible fakes without depending on `@types/bun`.

The duck-typed `BunS3ClientLike` exists so the adapter doesn't take a hard build-time dependency on `@types/bun`. Anything implementing the shape (the real `Bun.S3Client`, a test fake, a sandbox shim) plugs in. Keep this surface minimal — every method added here becomes part of the public type contract.

## Authentication / configuration

Two construction modes, mutually exclusive:

1. **Caller-supplied client.** Pass `{ client: Bun.s3 }` (or any `Bun.S3Client` instance constructed elsewhere). The adapter uses it as-is and **rejects** any of `bucket`, `region`, `endpoint`, `virtualHostedStyle`, `accessKeyId`, `secretAccessKey`, `sessionToken` at construction. The mismatch is surfaced loudly because the alternative — silently ignoring them while `adapter.bucket` reports a value the client never sees — is the kind of bug that survives review.
2. **Self-constructed client.** Omit `client` and pass any subset of those options; the adapter calls `new Bun.S3Client({...})` itself.

Env-var resolution is **Bun's job, not the adapter's**. Bun reads `S3_*` first, then `AWS_*` as aliases for `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `SESSION_TOKEN`, `REGION`, `BUCKET`. The adapter never touches `process.env`; if you're on a sandbox that strips it, pass values explicitly. The provider catalog notes (`readBy: "sdk-chain"`) reflect this — files-sdk does not own this resolution path.

`virtualHostedStyle` defaults to `false` (path-style). Flip it on for endpoints that demand virtual-hosted addressing. `defaultUrlExpiresIn` defaults to `DEFAULT_URL_EXPIRES_IN` (3600 s) from [`../internal/core.ts`](../internal/core.ts).

## Operation map

Deviations from the unified `Adapter<Raw>` contract in [`../index.ts`](../index.ts):

- **`upload(key, body, opts?)`** — rejects `cacheControl` and `metadata` (Bun.S3Client.write has no equivalents) with a `Provider` `FilesError`. The body union is forwarded to Bun's `write()` directly; only `ReadableStream` bodies are wrapped in `new Response(body)` to match Bun's accepted shapes. Content type follows the unified rule (`opts.contentType` wins, then `Blob.type`, then `text/plain; charset=utf-8` for strings, then `application/octet-stream`). After the write, the adapter does a follow-up `stat()` to surface authoritative `size`, `lastModified`, and `etag`; if that probe fails, it returns a thin `{ contentType, key, size }` rather than throwing.
- **`download(key, opts?)`** — supports `as: "stream"` (delegates to `Bun.S3File.stream()`). Buffer mode prefers `bytes()` and falls back to `arrayBuffer()` for older Bun versions. Both modes pre-fetch `stat()` to populate metadata; that's one extra round trip versus the `s3()` adapter, which reads metadata from the `GetObject` response. The cost is small in practice and lets the adapter share a single `storedFromStat` factory across `download()`, `head()`, and the post-write probe in `upload()`.
- **`head(key)`** — calls `client.stat(key)` for metadata; body accessors lazy-GET via `client.file(key).bytes()` on first use, in line with the unified `head()` contract.
- **`exists(key)`** — uses Bun's native `client.exists()` primitive (no probe scaffold). Maps `NotFound` to `false` and rethrows everything else.
- **`delete(key)`** — standard.
- **`deleteMany(keys, opts?)`** — **not implemented**. The SDK falls through to `deleteManyWithFallback` from [`../internal/core.ts`](../internal/core.ts), which fans out to `delete()` with bounded concurrency (default 8). Bun.s3 has no bulk-delete primitive to wire up.
- **`copy(from, to)`** — **client-side stream copy**. Bun.S3Client has no server-side `CopyObject`, so the adapter reads the source through this process and writes it to the destination. Doubled bandwidth, no atomicity, only the source `Content-Type` is preserved (no Content-Disposition, cache headers, custom user metadata, or ACL). For server-side copy on the same bucket, route to the `s3()` adapter.
- **`list(opts?)`** — maps `prefix` / `limit` / `cursor` to Bun's `prefix` / `maxKeys` / `continuationToken`. Items expose lazy bodies via `client.file(key).bytes()`. `lastModified` is parsed from a string or `Date`; invalid timestamps are dropped rather than surfaced as `NaN`.
- **`url(key, opts?)`** — presigned `GET` via `client.presign(key, { method: "GET", expiresIn, contentDisposition? })`. `publicBaseUrl` opts in to unsigned `${publicBaseUrl}/${encoded(key)}` via `joinPublicUrl`. `responseContentDisposition` forces signing even when `publicBaseUrl` is set (see URL behavior below).
- **`signedUploadUrl(key, opts)`** — **PUT only**. Throws a `Provider` `FilesError` on `maxSize` because Bun exposes presigned URLs, not S3 POST policy fields. Returns `{ method: "PUT", url, headers: { "Content-Type": opts.contentType }? }` — `headers` is omitted entirely when no `contentType` was requested. The browser-side `PUT` must echo the bound `Content-Type` exactly, or S3 rejects the upload at request time.

Body shapes accepted by `upload()` end up in `BunS3WritableBody` after the `ReadableStream` wrap: `string`, `ArrayBuffer`, `ArrayBufferView`, `Blob`, `Request`, `Response`. Bun's `write()` handles these natively, which is why this adapter skips the central `normalizeBody` helper.

## URL behavior

`url()` resolves via `resolveUrlStrategy` from [`../internal/core.ts`](../internal/core.ts):

- `publicBaseUrl` set, no `responseContentDisposition` → `joinPublicUrl(publicBaseUrl, key)` (unsigned, permanent, **URL-encoded**). `joinPublicUrl` encodes each path segment, so pass raw keys; pre-encoded keys double-encode.
- Otherwise → presigned `GET` with `expiresIn` (per-call, then `defaultUrlExpiresIn`, then 3600).

`responseContentDisposition` always forces signing — even with `publicBaseUrl` set — because a permanent CDN URL has no signature in which to bind the override. Silently dropping it would be a stored-XSS regression on user-uploaded HTML/SVG. The override wins, intentionally.

## Provider quirks worth remembering

- **Bun-only at construction.** `bunS3()` throws `"only available in the Bun runtime"` if `globalThis.Bun.S3Client` is missing. There is no graceful fallback to `@aws-sdk/client-s3`.
- **`client` and standalone options are mutually exclusive.** Passing both throws at construction with the offending keys named, so the mismatch can't sneak into production. Pick one mode.
- **`copy()` round-trips bytes through your process.** Same-bucket copy on a 5 GB object will move 5 GB through your network twice. Reach for `s3()` when this matters.
- **`upload()` rejects `cacheControl` / `metadata`.** Loud throw rather than silent drop. If Bun adds support, drop the guards and add the pass-through.
- **`signedUploadUrl()` rejects `maxSize`.** Bun has no S3 POST policy primitive. Without `maxSize`, S3 presigned PUTs have **no server-side size limit**; document this for callers and prefer `s3()` when size enforcement matters.
- **Post-write `stat()` is best-effort.** When the probe fails (rare; consistency window or revoked permissions mid-write), `upload()` returns `{ contentType, key, size }` without `etag` or `lastModified` rather than throwing. Don't treat the absence as failure.
- **`exists()` rethrows non-NotFound.** Auth (`AccessDenied`, `ERR_S3_INVALID_SIGNATURE`, `ERR_S3_INVALID_SESSION_TOKEN`, `ERR_S3_MISSING_CREDENTIALS`) and transport failures still throw. `false` means "the bucket exists, the key doesn't" — never "something else is broken".
- **ETag stripping.** Bun.S3Client returns ETags wrapped in literal double quotes (`"abc123"`). The adapter strips them via the module-level regex so callers see naked hex on every `head()`, `list()`, and `upload()` result.
- **`virtualHostedStyle` defaults to path-style.** That's the inverse of some S3-compatible providers' expectations — flip it on for those endpoints.
- **Bun owns env resolution.** files-sdk doesn't read env vars in this adapter at all. Don't add `readEnv()` calls; pass options explicitly when Bun's resolution doesn't fit the runtime.
- **`download({ as: "stream" })` is one-shot.** The returned `StoredFile` body is single-use per the rules in [`../internal/stored-file.ts`](../internal/stored-file.ts) — calling `stream()` and then `text()` (or vice versa) throws. Buffer first or stream once.
- **`presign()` is synchronous on Bun.** Unlike `@aws-sdk/s3-request-presigner` (which returns a `Promise<string>`), `Bun.S3Client.presign()` returns the URL directly and can throw synchronously on bad input. The adapter wraps the call in a `try { return Promise.resolve(...) } catch { return Promise.reject(mapBunS3Error(...)) }` to match the unified async contract — keep that wrapper in place if you refactor.
- **Bun's `contentDisposition` ≠ unified `responseContentDisposition`.** The user-facing `UrlOptions.responseContentDisposition` maps to Bun's `BunS3PresignOptions.contentDisposition`. Both names are correct in their own scope; the adapter does the rename at the call site. Don't surface Bun's name in the unified API.
- **`adapter.bucket` is optional.** The type is `readonly bucket?: string`. When Bun resolves the bucket from env (`S3_BUCKET` / `AWS_BUCKET`) and the caller didn't pass an explicit `bucket` option, the adapter can't see Bun's resolved value and `adapter.bucket` is `undefined`. Code that relies on `bucket` for telemetry should either pass it explicitly to `bunS3()` or read it off `Bun.s3` via `files.raw`.
- **`list()` items report `application/octet-stream` for `type`.** Bun's `list` response doesn't carry per-object content type; that's a protocol-level limitation of `ListObjectsV2`, not something the adapter can synthesize. Call `head(key)` for the real type when it matters per item.
- **Session tokens pass through.** `sessionToken` is forwarded to `Bun.S3Client` for temporary credentials (STS, IAM Identity Center). Treat it like any other secret — don't log it, don't bake it into images, refresh it before expiry.

### Error mapping

`mapBunS3Error` is built with `makeErrorMapper` from [`../internal/core.ts`](../internal/core.ts). The classification table is:

- `notFound`: `NoSuchKey`, `NotFound`
- `unauthorized`: `AccessDenied`, `ERR_S3_INVALID_SIGNATURE`, `ERR_S3_INVALID_SESSION_TOKEN`, `ERR_S3_MISSING_CREDENTIALS`
- `conflict`: `PreconditionFailed`

The extractor reads both the Bun-style `code` field and the AWS-style `Code` field, plus `status` / `statusCode` / `$metadata.httpStatusCode`, so consumers can throw either shape and have it classified consistently. HTTP status fallbacks (404 → NotFound, 401/403 → Unauthorized, 409/412 → Conflict) live in `makeErrorMapper` itself; don't duplicate them here. Existing `FilesError` instances pass through `mapBunS3Error` unchanged so adapters can rethrow their own programmatic errors without re-wrapping — this is exercised by the `pre-wrapped` test at the bottom of the suite.

### Choosing between `bun-s3` and `s3()`

Use `bun-s3` when the runtime is exclusively Bun and the bucket doesn't need server-side copy, presigned POST with a size policy, `cacheControl`, or per-object `metadata`. Use the [`s3()` adapter](../s3/index.ts) when any of those are required, or when the same code has to run on Node. The two adapters can coexist on the same bucket — wrap a `bun-s3` instance for the hot path and reach for `s3()` (or `files.raw`) only for the operations Bun's API can't express.

## Testing approach

Tests in [`../../test/bun-s3.test.ts`](../../test/bun-s3.test.ts) run under `bun:test` (`import { describe, expect, test } from "bun:test"`). Don't add `aws-sdk-client-mock` here — Bun.s3 doesn't go through the AWS SDK, and the AWS mocking helpers won't intercept its calls.

The fixture is a hand-rolled `FakeBunS3Client` implementing `BunS3ClientLike` end-to-end: an in-memory `Map<string, Entry>` for objects, a deterministic `presign()` that reflects its options into a query string against a fixed `signingOrigin = "https://signed.example.com"`, and a recorded `writes` log for asserting pass-through. URL assertions use that origin as a marker; `publicBaseUrl` tests use `"https://cdn.example.com/"` so signed-vs-public paths are distinguishable in `expect(url).toContain(...)`. Provider errors are fabricated with `Object.assign(new Error(...), { code, status })` to exercise both the Bun-style `code` and AWS-style `Code` paths through `mapBunS3Error`.

The default-client construction tests stub `globalThis.Bun.S3Client` with a fake constructor to verify option pass-through and the runtime-not-Bun guard, then restore the original in a `try / finally`. When you add a behavioral test that depends on `globalThis.Bun`, follow the same save-and-restore pattern so test ordering stays insensitive.

## Coding conventions

- **Named exports only.** No default exports; every public symbol is `export interface`, `export type`, `export const`, or `export function`. Public types live in `index.ts` next to the implementation.
- **All errors flow through `FilesError`.** Wrap underlying SDK errors with `mapBunS3Error`; throw programmatic errors directly with `new FilesError("Provider", ...)`. The mapper returns `FilesError` instances unchanged, so re-wrapping is safe.
- **Body normalization.** This adapter forwards bodies to `Bun.S3Client.write` directly because Bun's signature accepts the full union. If you ever need to inspect body bytes pre-write, route through `normalizeBody` from [`../internal/core.ts`](../internal/core.ts) instead of branching on the body union manually.
- **No `process.env` outside `readEnv`.** [`../internal/env.ts`](../internal/env.ts) is the only place env reads are allowed. This adapter currently doesn't read env at all (Bun does), so don't introduce one.
- **Top-level regex literals only.** The adapter has a single regex (`/^"+|"+$/gu` for ETag stripping) at module scope. Keep it that way — inline regex inside hot loops is a ReDoS risk and harms readability.
- **Spread-only optional fields.** When constructing options for Bun's API, use the `...(opts.x && { x: opts.x })` pattern (already pervasive in this file) rather than mutating an object after creation. Keeps the call site readable and avoids leaking `undefined` into Bun's option parsers.

## Releases

Behavioral changes ship via Changesets. Run `bunx changeset`, choose `files-sdk` as the bumped package, and describe the user-visible change. Pure documentation edits (this file, [`../../README.md`](../../README.md), the docs MDX, the provider catalog `description`) do not need a changeset — `AGENTS.md` and `CLAUDE.md` updates are for agents, not consumers.

## Where to look next

- [User-facing docs](../../../../apps/web/content/docs/adapters/bun-s3.mdx)
- [Adapter implementation](index.ts)
- [Tests](../../test/bun-s3.test.ts)
- [Provider catalog entry](../providers/index.ts) — search for `slug: "bun-s3"`
- [Unified `Adapter<Raw>` contract](../index.ts) — option and result shapes
- [Shared adapter helpers](../internal/core.ts) — `makeErrorMapper`, `joinPublicUrl`, `resolveUrlStrategy`, `DEFAULT_URL_EXPIRES_IN`, `normalizeBody`, `existsByProbe`, `collectStream`, `deleteManyWithFallback`
- [`StoredFile` factory](../internal/stored-file.ts) — body-source kinds and the one-shot stream rule
- [`FilesError` and codes](../internal/errors.ts)
- [Sibling AWS-SDK adapter](../s3/index.ts) — route here when you need server-side copy, presigned POST with size policy, `cacheControl`, or `metadata`
- [Package manifest](../../package.json) — exports map and peer-dep matrix
