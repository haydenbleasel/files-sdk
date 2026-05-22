# AGENTS.md — `files-sdk/appwrite`

Guidance for coding agents working inside the `files-sdk/appwrite`
adapter. The unified `Adapter` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only Appwrite-specific
behavior. Cross-references: [`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

Appwrite is a **native** adapter on `node-appwrite` `Storage` (not
`s3()`). Typical bugs: file-ID validation, upload-option strictness
(`metadata` / `cacheControl` throw; `contentType` dropped), or
`url()` / `signedUploadUrl()` unsupported paths.

## Overview

[Appwrite Storage](https://appwrite.io/docs/products/storage) via
`node-appwrite`. **BaaS object storage** — bucket + file ID, API key
auth. Keys are Appwrite file IDs (`$id`), not paths; slashes are
invalid. Operations map to `createFile`, `getFile`, `getFileDownload`,
`deleteFile`, `listFiles`. `signedUploadUrl()` always throws. Peer:
`node-appwrite`.

## Directory layout

```text
packages/files-sdk/src/appwrite/
├── index.ts                # appwrite() factory + mapAppwriteError
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files outside this directory:

- Tests: [`../../test/appwrite.test.ts`](../../test/appwrite.test.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/appwrite.mdx`](../../../../apps/web/content/docs/adapters/appwrite.mdx).
- Provider catalog entry (search `slug: "appwrite"`):
  [`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/appwrite.test.ts   # adapter unit tests only
bun test                         # full SDK suite
bun run build                    # tsup ESM bundle -> dist/appwrite/
bun run types                    # tsgo --noEmit (typecheck only)
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`). The per-subpath bundle output is `dist/appwrite/index.{js,d.ts}`
per the `exports` map in [`../../package.json`](../../package.json).

## Public surface

Defined in [`./index.ts`](./index.ts):

- `appwrite(opts: AppwriteAdapterOptions): AppwriteAdapter` — primary
  factory.
- `AppwriteAdapter` — `Adapter<Storage> & { readonly bucket: string }`.
  `raw` is the underlying `node-appwrite` `Storage` instance.
- `AppwriteAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (the docs MDX pulls it via `AutoTypeTable`).
- `mapAppwriteError(err): FilesError` — exported for tests.

`name` is `"appwrite"`.

## Authentication / configuration

Required:

- `bucket` — Appwrite storage bucket ID (`bucketId` on every Storage
  call). **No env fallback**; pass it explicitly. The provider catalog
  lists `bucket` under `config`, not credential env vars.

Construction without `client` also requires `projectId` (option or
`APPWRITE_PROJECT_ID` / `NEXT_PUBLIC_APPWRITE_PROJECT_ID`). Missing
`projectId` throws `FilesError("Provider", "Appwrite adapter requires
a projectId or an existing client")`.

Optional / env-backed:

- `endpoint` — defaults to `https://cloud.appwrite.io/v1`, overridable
  via `APPWRITE_ENDPOINT` or `NEXT_PUBLIC_APPWRITE_ENDPOINT`.
- `key` — API key for `client.setKey()`. Falls back to
  `APPWRITE_API_KEY` or `APPWRITE_KEY`. Server-side Storage operations
  need a key with appropriate scopes; the adapter does not validate
  scopes at construction.
- `client` — highest precedence. Accepts a `Client` or `Storage`
  instance you already configured. When a `Storage` is passed,
  `endpoint` / `projectId` are inferred from `storage.client.config`
  when present (needed for `url()` when `public: true`).
- `public` — when `true`, `url()` returns a permanent unsigned view URL
  for a **public** bucket; otherwise `url()` rejects.

Env lookups use [`readEnv`](../internal/env.ts) so the adapter is safe
to import on runtimes without `process` (Cloudflare Workers without
`nodejs_compat`).

## Operation map

Every SDK call passes `bucketId: opts.bucket`. Errors are caught and
rethrown through `mapAppwriteError`.

- `upload` — validates the key with `assertAppwriteKey`, rejects
  non-empty `metadata` and any `cacheControl` (see Provider quirks),
  buffers the body via shared [`normalizeBody`](../internal/core.ts)
  and [`collectStream`](../internal/core.ts) into
  `InputFile.fromBuffer`, then `storage.createFile({ fileId: key, … })`.
  `UploadOptions.contentType` is **silently ignored** — Appwrite
  auto-detects MIME from the payload. Returns `{ key: $id, size,
  contentType: mimeType }`.
- `download` — parallel `getFile` + `getFileDownload`; eager
  `StoredFile` with buffer body.
- `head` — `getFile` only; lazy `StoredFile` that calls
  `getFileDownload` on first body read.
- `exists` — [`existsByProbe`](../internal/core.ts) on `getFile`;
  `NotFound` → `false`, other errors propagate.
- `delete` — `deleteFile`. No adapter-level `deleteMany`; `Files`
  falls back to per-key deletes via [`deleteManyWithFallback`](../internal/core.ts).
- `copy` — **read-then-write**: `getFileDownload` from `from`, then
  `createFile` with `fileId: to` (no native server-side copy). Uses `to`
  as the `InputFile` filename to avoid an extra metadata roundtrip.
  Destination key is validated with `assertAppwriteKey`.
- `list` — `listFiles` with `Query.limit` (default **100**),
  optional `Query.startsWith("$id", prefix)`, and
  `Query.cursorAfter(cursor)`. Items are lazy `StoredFile`s keyed by
  `$id`. `nextCursor` is the last item's `$id` when the page is full
  (`files.length === limit`); otherwise `cursor` is omitted.
- `url` — see URL behavior.
- `signedUploadUrl` — always rejects with `Provider` and guidance to
  use a JWT or the client SDK for direct uploads.

Supported upload body shapes: `string`, `Uint8Array`, `ArrayBuffer`,
`ArrayBufferView`, `Blob`, `ReadableStream`. Other types throw
`Provider` before the SDK is called.

## URL behavior

Two states only — no presigned read URLs with API keys:

1. **`public` unset / false (default)** — `url()` rejects:
   `appwrite: url() is not supported. … set { public: true } …`
2. **`public: true`** — returns
   `${endpoint}/storage/buckets/${bucket}/files/${key}/view?project=${projectId}`.
   Requires `endpoint` and `projectId` to be known; if both are missing
   after client inference, rejects with `missing endpoint or projectId`.

There is no `publicBaseUrl`, no `defaultUrlExpiresIn`, and no
`responseContentDisposition` support on this adapter. Unsigned URLs are
permanent for public buckets — not suitable for private objects.

## Error mapping

`mapAppwriteError` uses [`makeErrorMapper`](../internal/core.ts) with
empty code sets — classification is HTTP-only. `AppwriteException.code`
is hoisted to `status` for the shared classifier (404/401/403/409/412
buckets). Fallback label: `"Appwrite error"`. `FilesError` passthrough.
Local validation throws `Provider` before the SDK runs.

## Provider quirks worth remembering

- **File IDs are not paths.** Regex
  `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$` — max 36 chars, must start
  alphanumeric, no `/`. Invalid keys fail locally with a clear message.
- **`metadata` throws; empty `{}` is allowed.** Non-empty
  `UploadOptions.metadata` rejects before `createFile` (dropbox/box
  pattern — don't swallow explicit caller intent). Use `adapter.raw` if
  you need Appwrite-specific metadata elsewhere.
- **`cacheControl` throws.** Appwrite has no HTTP cache header on file
  content.
- **`contentType` is silently dropped.** MIME comes from Appwrite's
  detection on upload; returned `contentType` on the upload result is
  whatever Appwrite stored.
- **No presigned upload.** `signedUploadUrl()` always throws. Direct
  browser uploads typically need Appwrite's client SDK + JWT/session,
  not this server adapter.
- **No presigned read with API keys.** Private buckets need
  `getFileDownload` (what `download` / lazy bodies use), not `url()`.
- **`copy()` costs egress + ingress.** Full object is downloaded then
  re-uploaded; large files are expensive.
- **Streams are buffered.** `InputFile.fromBuffer` has no streaming
  form — `ReadableStream` bodies are fully collected first.
- **`list({ prefix })` filters `$id`, not display `name`.** Files
  created in the console where `name` ≠ `$id` won't match prefix queries
  keyed the way this adapter uploads (`fileId` and filename both set to
  the virtual key).
- **SDK typing vs runtime.** `createFile` types `file` as DOM `File`;
  Node passes `InputFile` from `node-appwrite/file` via cast — required
  at runtime, not a bug to "fix" with a real `File` polyfill unless
  tests prove otherwise.

## Testing approach

[`../../test/appwrite.test.ts`](../../test/appwrite.test.ts) mocks
`node-appwrite` and covers construction/env, every operation (lazy
bodies, list cursor/prefix, copy args), upload bodies and option
throws, `url`/`signedUploadUrl`, and HTTP error mapping. Use
`bun test`; keep Appwrite-specific cases here.

## Coding conventions

- Named exports only — `appwrite`, `AppwriteAdapter`,
  `AppwriteAdapterOptions`, `mapAppwriteError`.
- Use [`readEnv`](../internal/env.ts) — never `process.env` directly.
- Use [`createStoredFile`](../internal/stored-file.ts) for every
  `StoredFile` returned.
- Throw unsupported upload options at the boundary (don't no-op
  `metadata` / `cacheControl`). Silently ignore only `contentType`.
- Validate keys with `assertAppwriteKey` before upload/copy destination.
- Top-level regex only (`APPWRITE_KEY_RE`) — keep it that way.
- Preserve `AppwriteException.code` → `status` hoisting in
  `mapAppwriteError.extract`; Appwrite does not use AWS-style string
  error codes in the empty code sets.

## Releases

Ships with the monorepo from
[`../../package.json`](../../package.json). Behavioral changes need a
changeset on `files-sdk`. README / AGENTS.md / test-only edits do not.
The `./appwrite` export is already wired in `exports` and
[`../../tsup.config.ts`](../../tsup.config.ts).

## Where to look next

- Contract: [`../index.ts`](../index.ts); source: [`./index.ts`](./index.ts);
  tests: [`../../test/appwrite.test.ts`](../../test/appwrite.test.ts).
- Internals: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Catalog (`slug: "appwrite"`): [`../providers/index.ts`](../providers/index.ts).
- Docs: [`../../../../apps/web/content/docs/adapters/appwrite.mdx`](../../../../apps/web/content/docs/adapters/appwrite.mdx),
  [`../../README.md`](../../README.md),
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
