# AGENTS.md — `files-sdk/pocketbase`

Guidance for coding agents working inside the `files-sdk/pocketbase`
adapter. Every adapter implements the same `Adapter<Raw>` contract from
[`../index.ts`](../index.ts); this file documents only the
pocketbase-specific deviations. For the unified surface, read
[`../../README.md`](../../README.md) and
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
first.

PocketBase is a **native** adapter — it talks to the official
`pocketbase` JS SDK directly rather than going through `s3()`. Most
bugs land in deferred auth (superuser vs token vs public rules),
collection/field wiring (the adapter does not create schemas), or the
two-step read path (record lookup, then `fetch()` on `pb.files.getURL`).

## Overview

[PocketBase](https://pocketbase.io) via the official `pocketbase` SDK.
Family: **self-hosted BaaS** — no object-store primitive. Files live as
single-value file fields on collection records. The adapter maps the
unified key/blob API onto one collection: a unique-indexed text
`keyField` (default `"key"`) and a single-file `fileField` (default
`"file"`).

Operations use `collection().create` / `update` / `delete` /
`getFirstListItem` / `getList` plus `pb.files.getURL` and `fetch()` for
bytes. `signedUploadUrl()` throws — no presigned upload primitive.
Optional peer dependency: `pocketbase`.

## Directory layout

```text
packages/files-sdk/src/pocketbase/
├── index.ts                # adapter implementation + auth + mapping
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

- Tests: [`../../test/pocketbase.test.ts`](../../test/pocketbase.test.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/pocketbase.mdx`](../../../../apps/web/content/docs/adapters/pocketbase.mdx).
- Provider catalog (search `slug: "pocketbase"`):
  [`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/pocketbase.test.ts   # adapter unit tests
bun test                            # full SDK suite
bun run build                       # tsup -> dist/pocketbase/
bun run types                       # tsgo --noEmit
```

Uses **`bun test`** and **`tsgo`**. Subpath bundle:
`dist/pocketbase/index.{js,d.ts}` per [`../../package.json`](../../package.json).

## Public surface

Defined in [`./index.ts`](./index.ts):

- `pocketbase(opts): PocketBaseAdapter` — primary factory.
- `PocketBaseAdapter` — `Adapter<PocketBaseClient> & { readonly collection: string }`.
- `PocketBaseAdapterOptions` — JSDoc is source of truth (MDX `AutoTypeTable`).
- `mapPocketBaseError(err): FilesError` — exported for tests/callers.

`raw` is the `PocketBase` client; `name` is `"pocketbase"`.

## Authentication / configuration

**Required:** `collection` — no env fallback; missing value throws at
construction. Provision the collection first (admin UI or migrations):
unique-indexed text `keyField`, single-value `fileField`. The adapter
never creates or migrates it.

**Connection (one of):**

1. **`client`** — pre-built `PocketBase` instance (highest precedence;
   ignores all auth options below).
2. **`url`** — backend origin; falls back to `POCKETBASE_URL`.

**Auth (deferred to first API call):** sync factory; `ensureAuth()` runs
once, re-runs when `authStore.isValid` is false. Failed auth clears the
cached promise for retry.

1. **`authToken`** / `POCKETBASE_AUTH_TOKEN` — `authStore.save(token, null)`.
   **Wins** over admin email/password.
2. **Admin email + password** / `POCKETBASE_ADMIN_*` —
   `collection("_superusers").authWithPassword` (v0.23+ superusers).
3. **No credentials** — unauthenticated; works when API rules allow public
   access; protected collections return `Unauthorized`.

**Optional:** `keyField`, `fileField`, `publicBaseUrl` (CDN short-circuit for
`url()`). Env via [`readEnv`](../internal/env.ts). Catalog entry documents
`POCKETBASE_URL` plus token vs admin credential modes.

## Operation map

API methods await `ensureAuth()` first (`url()` skips lookup when
`publicBaseUrl` is set). Errors go through `mapPocketBaseError`.

- `upload` — `collectStream` for `ReadableStream`; `FormData` + `Blob` only.
  Probe by key: 404 → `create`, hit → `update`. Filename hint is the last
  path segment of `key`; PocketBase adds its own suffix — trust `fileField`
  on the record. **`metadata` throws** when non-empty (typed fields only;
  use `raw` for extra columns). **`cacheControl` throws**.
- `download` — lookup + `files.getURL` + `fetch()`. Tries `files.getToken()`
  when authed (swallows failure for public collections). Accurate `size`;
  `type` is always `application/octet-stream`.
- `head` — lazy body (`kind: "lazy"`). `size` is **0** until body access —
  record JSON has no file size/MIME. `metadata`: `{ filename, recordId }`.
- `exists` — [`existsByProbe`](../internal/core.ts) on `getFirstListItem`.
- `delete` — by record id; idempotent on `NotFound`.
- `copy` — download then `create` (not atomic).
- `list` — `getList`, `sort: keyField`, prefix via `pb.filter`. Default
  `limit` 30; cursor is a **page number** string. Invalid cursor → `Provider`.
- `url` — see URL behavior; `signedUploadUrl` throws (mint a short-lived
  auth token for browser uploads instead).

Filters: always `pb.filter(\`${keyField} = {:k}\`, { k })` and
`pb.filter(\`${keyField} ~ {:p}\`, { p: \`${prefix}%\` })` — never
hand-built escapes. `AbortSignal` via `SendOptions` on SDK calls and on
download `fetch()`.

`mapPocketBaseError` uses [`makeErrorMapper`](../internal/core.ts) with
empty PocketBase code sets — HTTP status drives classification: 404 →
`NotFound`, 403 → `Unauthorized`, 409 → `Conflict`, else `Provider`
(`"PocketBase error"`). `FilesError` passthrough; download fetch 404 →
`NotFound`.

## URL behavior

1. **`publicBaseUrl`** — `${base}/${encodeURIComponent(key)}`; trailing
   slash stripped; no lookup or token.
2. **Default** — lookup, optional `files.getToken()`, `files.getURL`.
   Token failure swallowed for public collections.

`responseContentDisposition` throws — use `?download=true` via `raw`.
No caller-controlled `expiresIn` on file URLs.

## Provider quirks worth remembering

- **Schema is caller-owned** — wrong fields or missing unique index fail at
  runtime, not construction.
- **`UploadOptions.metadata` throws** vs read-only `StoredFile.metadata`
  `{ filename, recordId }`. `recordId` is the PocketBase record id for
  `raw` updates/relations — not the user key.
- **Key vs record id** — callers use keys; delete/update resolve record ids.
  Duplicate keys on create → `Conflict` (409).
- **`_superusers` admin auth** — server-side only; user JWTs via `authToken`.
- **No server-side copy** — `copy()` is egress + ingest.
- **Page-based list** — loop `cursor` + `limit`; no folder recursion.
- **Buffered streams** — large `ReadableStream` uploads need `raw`.
- **Randomized filenames** — trust `metadata.filename`, not the upload hint.

## Testing approach

[`../../test/pocketbase.test.ts`](../../test/pocketbase.test.ts) mocks
`pocketbase` with `FakePocketBase` + `FakeClientResponseError` (must
extend `Error` for `instanceof ClientResponseError` checks), stubs
`globalThis.fetch` for `/api/files/...` downloads, and mirrors one
collection in a `Map`. Key suites:

- Construction: missing `collection` / `url`; env fallbacks; `adapter.raw`
  when `client` is passed.
- Upload: create vs update dedupe; **`metadata` and `cacheControl` throw**.
- Reads: download/head lazy fetch; file token vs unsigned fallback.
- Mutations: idempotent delete; copy read-then-write; list prefix + pages.
- Auth: admin runs once; `authToken` skips admin; promise reset on failure.
- Errors: `mapPocketBaseError` status table; empty `fileField`; signal forward.

Extend `FakePocketBase` rather than inventing new SDK shapes inline.

## Coding conventions

- Named exports only.
- `FilesError("Provider", …)` at construction; `mapPocketBaseError` in catches.
- [`readEnv`](../internal/env.ts), [`createStoredFile`](../internal/stored-file.ts),
  shared [`normalizeBody`](../internal/core.ts) + `collectStream`.
- `pb.filter()` for filters; `sendOpts(signal)` returns `undefined` without signal.

## Releases

Ships from [`../../package.json`](../../package.json). Behavioral changes
need a version bump + [`CHANGELOG.md`](../../CHANGELOG.md) entry; docs/tests
only do not. `pocketbase` subpath is already in `exports`.

## Where to look next

- Contract: [`../index.ts`](../index.ts); source: [`./index.ts`](./index.ts);
  tests: [`../../test/pocketbase.test.ts`](../../test/pocketbase.test.ts).
- Internals: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Catalog: [`../providers/index.ts`](../providers/index.ts) (`slug: "pocketbase"`).
- Docs: [`pocketbase.mdx`](../../../../apps/web/content/docs/adapters/pocketbase.mdx),
  [`README`](../../README.md),
  [`SKILL`](../../../../skills/files-sdk/SKILL.md).
