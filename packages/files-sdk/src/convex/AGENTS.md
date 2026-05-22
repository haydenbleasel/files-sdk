# AGENTS.md — `files-sdk/convex`

Guidance for coding agents working on the `convex` adapter
([Convex file storage](https://docs.convex.dev/file-storage), exposed at
the `files-sdk/convex` subpath). The unified `Adapter<Raw>` contract —
call shapes, `FilesError`, `UrlOptions`, `SignUploadOptions`, body
normalization — lives in [`../index.ts`](../index.ts); read it first.
This file documents only convex-specific behavior. Cross-references:
[`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

This is a **native** adapter — no inner `s3()` shim, no AWS SDK, no HTTP
client you configure at the edge. Every operation is implemented against
Convex's in-deployment file storage API: `ctx.storage` for blob I/O and
URL minting, and `ctx.db.system` for enumerating the built-in `_storage`
system table. Construct it **per Convex function invocation** with the
live function context: `convex({ ctx })` inside your `action`, `mutation`,
or `query` handler.

Convex is **not object storage**. There are no buckets, regions, access
keys, or a public REST surface you call from outside the deployment.
Files live in Convex storage scoped to a single deployment; auth is
implicit in the function context (your deployment URL and Convex's
runtime), not static credentials in env vars. The unified `key` is
Convex's opaque storage id (`Id<"_storage">`, typed as `string` here) —
the caller never chooses it on upload.

`convex(opts)` returns `Adapter<ConvexCtx>`. `raw` is the same `ctx`
object you passed in (`storage` plus optional `db.system`), so the escape
hatch is the full Convex context — call `files.raw.storage.store(...)` or
query `files.raw.db.system` directly when you need primitives outside the
unified API.

Peer dep: [`convex`](https://www.npmjs.com/package/convex), optional in
[`../../package.json`](../../package.json). Shared plumbing:
[`../internal/core.js`](../internal/core.js) (`normalizeBody`,
`collectStream`), [`../internal/stored-file.js`](../internal/stored-file.js),
[`../internal/errors.js`](../internal/errors.js).

## How this differs from object storage

Object-storage adapters (S3, R2, GCS, Wasabi, …) share a mental model:
hierarchical keys under a named bucket, long-lived credentials or IAM,
presigned URLs with expiry, and often user metadata on the object.
Convex file storage breaks that model in ways that affect every method:

| Object storage assumption | Convex behavior |
| ------------------------- | --------------- |
| Caller chooses the object key | `upload()` **ignores** the key argument; Convex assigns `Id<"_storage">` and returns it as `UploadResult.key`. Persist that id in your own table. |
| Keys are path-like (`avatars/uuid.png`) | Storage ids are opaque strings (e.g. `kg2abc…`). `list({ prefix })` filters by **literal id prefix**, not folder paths — rarely useful. |
| Bucket + region + credentials | Single deployment store; **no env vars**. Only `ctx` from the running function. |
| `metadata` / `cacheControl` on the object | `_storage` is fixed: `contentType`, `sha256`, `size`, `_creationTime`. Custom metadata must live in **your** table keyed by the storage id. |
| `copy(from, to)` server-side | **Unsupported** — ids are immutable; download then upload and track the new id. |
| Presigned GET with `expiresIn` | `url()` returns a **permanent** serving URL while the file exists; `expiresIn` is ignored. |
| Multipart POST signed upload | `signedUploadUrl()` returns `{ method: "POST", url, fields: {} }` — browser sends the **raw body**, response JSON `{ storageId }` is the key. |

Do **not** set `prefix` on `new Files({ adapter, prefix })` with this
adapter — the SDK would prepend a path segment and corrupt the storage id.
Use unscoped keys that are exactly the Convex storage id.

## Directory layout

```text
packages/files-sdk/src/convex/
├── index.ts          # convex() factory + ConvexAdapterOptions
├── AGENTS.md         # this file
└── CLAUDE.md         # `@AGENTS.md` — Claude-Code re-export
```

Sibling files: tests at
[`../../test/convex.test.ts`](../../test/convex.test.ts); user-facing docs at
[`../../../../apps/web/content/docs/adapters/convex.mdx`](../../../../apps/web/content/docs/adapters/convex.mdx);
subpath export at `exports["./convex"]` in
[`../../package.json`](../../package.json).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/convex.test.ts   # this adapter only
bun test                        # full SDK suite
bun run build                   # tsup ESM → dist/convex/
bun run types                   # tsgo --noEmit
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not `tsc`).
The type-assignability tests in `convex.test.ts` only compile under
`bun run types` — they guard that real `GenericActionCtx` /
`GenericMutationCtx` / `GenericQueryCtx` remain assignable to `ConvexCtx`.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `convex(opts: ConvexAdapterOptions): ConvexAdapter` — primary factory.
  Requires `opts.ctx` with at least `storage.getUrl`.
- `ConvexAdapter` — `Adapter<ConvexCtx>`. `raw` is the passed-in `ctx`.
- `ConvexAdapterOptions` — `{ ctx: ConvexCtx }`; JSDoc on `ctx` documents
  per-context operation availability (docs MDX pulls via `AutoTypeTable`).
- `ConvexCtx` — structural type for `storage` + optional `db.system`.
  Real Convex contexts are assignable without casting (verified in tests).

The adapter's `name` is `"convex"`.

## Authentication / configuration

There is **no** `readEnv` path and no provider env vars. The provider
catalog entry (`slug: "convex"` in
[`../providers/index.ts`](../providers/index.ts)) lists config as
`ctx (Convex function context)` with the note that upload/download need
an action and list needs a query or mutation.

Required:

- `ctx` — the Convex function context for the current request. Missing
  or invalid `ctx` throws `FilesError("Provider", …)` at construction.

Which operations work depends on what Convex exposes on that `ctx`
(feature-detected at runtime, not by function kind enum):

| Context | Typical availability |
| ------- | -------------------- |
| **action** / **httpAction** | `upload`, `download`, `delete`, `url`, `head`, `exists`, `signedUploadUrl`. **`list` throws** (no `ctx.db`). |
| **mutation** | `delete`, `url`, `head`, `exists`, `list`, `signedUploadUrl`. **`upload` / `download` throw** (no `store` / `get`). |
| **query** | `url`, `head`, `exists`, `list` (read-only). No writes, no signed upload URL. |

The adapter checks `typeof storage.<method> === "function"` (and
`ctx.db` for `list`) and throws a descriptive `FilesError("Provider", …)`
when the primitive is missing — do not assume all methods work in every
handler.

## Operation map

Errors flow through `mapConvexError`: not-found phrasing in the message →
`NotFound`; everything else → `Provider` with the original error as
`cause`. Convex often signals absence with `null` returns; those paths
are handled inline before mapping.

| Method | Behavior |
| ------ | -------- |
| `upload` | `storage.store(blob)` after [`normalizeBody`](../internal/core.js). Caller `key` **ignored**; returned `key` is the assigned id. Rejects `metadata` and `cacheControl`. Requires action context. |
| `download` | `storage.get` → buffer `StoredFile`; `etag` from sha256, `lastModified` from system table when available. Requires action context. |
| `head` | Metadata via `readMeta` (`ctx.db.system.get("_storage", id)` preferred, else `storage.getMetadata`). Lazy body via `loadBytes` (action only). If metadata missing but `getUrl` succeeds, returns minimal metadata (`size: 0`, empty sha256). |
| `exists` | `storage.getUrl(key) !== null`. `NotFound` from provider → `false`. |
| `delete` | `storage.delete`; idempotent when mapped error is `NotFound`. Requires mutation or action. |
| `list` | `ctx.db.system.query("_storage").paginate({ cursor, numItems })`; default `limit` 1000. Requires query or mutation. Items use lazy `loadBytes` factories. |
| `url` | `storage.getUrl`; permanent URL. `expiresIn` ignored. `responseContentDisposition` throws — no signature to bind override. |
| `signedUploadUrl` | `storage.generateUploadUrl()` → POST with empty `fields`. Convex controls ~1h expiry; `expiresIn` / size / content-type opts ignored. Key arg ignored. |
| `copy` | Always throws — immutable ids, no server-side copy to a chosen key. |

`deleteMany` is not implemented; the `Files` class falls back to
per-key `delete` via [`deleteManyWithFallback`](../internal/core.js).

`readMeta(key)` centralizes metadata: prefers `ctx.db.system.get("_storage",
key)` (includes `_creationTime` → `lastModified`); in actions without
`db`, falls back to deprecated `storage.getMetadata`.

## URL behavior

- **Permanent serving URLs.** `url(key)` returns whatever Convex's
  `storage.getUrl` provides; valid while the file exists. Do not treat
  `expiresIn` as meaningful.
- **`responseContentDisposition` throws `Provider`.** Convex URLs have no
  signing primitive to bind a Content-Disposition override; silently
  dropping it would be a stored-XSS regression on user-uploaded HTML/SVG
  (same rationale as [`resolveUrlStrategy`](../internal/core.js) on
  signing adapters).
- **Untrusted downloads.** Serve sensitive or user-uploaded content through
  your own HTTP action with explicit headers rather than relying on
  `url()` overrides.

## Signed upload flow

`signedUploadUrl()` is for browser-direct uploads via Convex's upload
endpoint:

1. Call from a **mutation or action** (writer context).
2. Client `POST`s the file as the **raw request body** (not multipart
   form data).
3. Response body is JSON `{ storageId }` — that string is the file's
   `key` for subsequent `download` / `head` / `delete` / `url`.

The unified `SignedUpload` shape uses `fields: {}` because Convex does not
use S3-style POST policies.

## Provider quirks worth remembering

- **Store extra fields in your schema.** Link `storageId` in a `files`
  table (or similar) for filenames, ownership, ACLs — the adapter cannot
  attach arbitrary metadata to `_storage`.
- **`etag` is sha256.** Mapped from Convex's content hash, not a weak
  HTTP ETag from a CDN.
- **Lazy list/head bodies need actions.** `head()` from a query returns
  metadata but `arrayBuffer()` on the `StoredFile` throws until you read
  from an action context (tests assert this).
- **Type branding.** Real Convex code uses `Id<"_storage">`; the adapter
  uses plain `string` so structural typing stays simple. Branded ids are
  assignable to `string`.
- **No `readEnv`.** Unlike S3-style adapters, never add env-based config
  here — it would imply an external API that does not exist.
- **Convex `null` vs throw.** `get`, `getUrl`, and metadata helpers return
  `null` for missing files; the adapter translates those to `NotFound` or
  `false` (`exists`) as appropriate.

## Testing approach

[`../../test/convex.test.ts`](../../test/convex.test.ts) uses an in-memory
fake that mirrors Convex's context gating (`actionCtx`, `mutationCtx`,
`queryCtx` from one shared store). Coverage includes:

- Construction without `ctx`, `name` / `raw` exposure.
- Upload ignoring caller key, body shapes (string, `Uint8Array`, `Blob`,
  stream), explicit `contentType`, unsupported `metadata` / `cacheControl`.
- Context gating errors for upload/download/list/signedUploadUrl.
- `head` lazy body, `lastModified` from system table in query context,
  `exists`, idempotent `delete`.
- `url` serving URL and `responseContentDisposition` rejection.
- `signedUploadUrl` POST shape; `copy` unsupported.
- `list` pagination and metadata on items.
- `Files` wrapper integration (`files.raw === ctx`).
- Type-level assignability of real Convex context types to `ConvexCtx`
  (compile-only under `bun run types`).

Extend this fake when adding behavior — do not hit a live deployment from
unit tests.

## Coding conventions

- Named exports only — `convex`, `ConvexAdapter`, `ConvexAdapterOptions`,
  `ConvexCtx`.
- Use [`normalizeBody`](../internal/core.js) and [`collectStream`](../internal/core.js)
  for uploads; [`createStoredFile`](../internal/stored-file.js) for every
  `StoredFile`.
- Feature-detect Convex methods with `typeof fn === "function"` — Convex
  gates APIs by context; do not branch on a hard-coded handler kind string.
- `ConvexStorageLike` uses method declarations (not arrow properties) so
  TypeScript's method-parameter bivariance accepts real `StorageReader` /
  `StorageWriter` types with branded `Id<"_storage">` parameters.
- Top-level regex only in `mapConvexError` (`/not found|…/iu`) — keep new
  patterns at module scope.
- Throw `FilesError("Provider", …)` for unsupported options and missing
  context; preserve `cause` when re-wrapping caught errors.
- Do not add bucket/region/credential options — stay aligned with Convex's
  deployment-scoped storage model.

## Releases

Ships with the rest of the monorepo via Changesets. Behavioral changes
need a changeset (`bunx changeset`, pick `files-sdk`). Pure docs / test
additions do not. The `convex` subpath is already in `exports` — new
options only need JSDoc + MDX `AutoTypeTable` updates unless the export
map changes.

## Where to look next

- Source: [`./index.ts`](./index.ts); tests:
  [`../../test/convex.test.ts`](../../test/convex.test.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/convex.mdx`](../../../../apps/web/content/docs/adapters/convex.mdx).
- Provider catalog (search `slug: "convex"`):
  [`../providers/index.ts`](../providers/index.ts).
- Unified contract: [`../index.ts`](../index.ts); shared helpers:
  [`../internal/core.js`](../internal/core.js),
  [`../internal/errors.js`](../internal/errors.js),
  [`../internal/stored-file.js`](../internal/stored-file.js).
- Package README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Upstream: [Convex file storage](https://docs.convex.dev/file-storage).
