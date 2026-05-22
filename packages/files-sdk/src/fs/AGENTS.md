# AGENTS.md — `files-sdk/fs`

Guidance for coding agents working on the `fs` adapter. The unified
`Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only fs-specific
behavior. Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

Native Node.js filesystem adapter for **local dev and CI**. Family:
**direct-binding / no peer deps**. Implements the common adapter surface
against `node:fs/promises` — `upload`, `download`, `head`, `exists`,
`delete`, `copy`, `list`, `url`, `signedUploadUrl` — with no cloud SDK,
no replication, no auth, and no real signing. Each object is a body file
on disk plus a JSON sidecar (`.meta.json`) for Content-Type, ETag,
`cacheControl`, and user metadata. Swap this adapter in to exercise the
same `Files` call sites as production without changing application code.
**Not for production.**

Peer dependencies: none. Requires Node or Bun with `node:fs`,
`node:fs/promises`, `node:path`, `node:crypto`, and `node:stream`.

## Directory layout

```text
packages/files-sdk/src/fs/
├── index.ts                # fs() factory + FsAdapterOptions
├── AGENTS.md               # this file
└── CLAUDE.md               # @AGENTS.md — Claude-Code re-export
```

Tests: [`../../test/fs.test.ts`](../../test/fs.test.ts); user docs:
[`../../../../apps/web/content/docs/adapters/fs.mdx`](../../../../apps/web/content/docs/adapters/fs.mdx);
provider catalog: [`../providers/index.ts`](../providers/index.ts)
(search `slug: "fs"`).

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/fs.test.ts            # adapter unit tests only
bun test                            # full SDK suite
bun run build                       # tsup -> dist/fs/index.js
bun run types                       # tsgo --noEmit
```

The `fs` subpath is in [`package.json`](../../package.json) `exports` as
`files-sdk/fs` → `dist/fs/index.{js,d.ts}`.

## Public surface

Exports from [`index.ts`](index.ts):

- `fs(opts: FsAdapterOptions): FsAdapter` — primary factory.
- `FsAdapterOptions` — `root`, optional `urlBaseUrl`,
  `defaultUrlExpiresIn`. JSDoc is the source of truth; docs MDX uses
  `AutoTypeTable`.
- `FsAdapter` — `Adapter<{ root: string }> & { readonly root: string }`.
  `raw` is `{ root }` (resolved absolute path); getter `root` mirrors it.
- `mapFsError(err: unknown): FilesError` — errno → `FilesErrorCode`.

Adapter `name` is `"fs"`.

## Authentication / configuration

No credentials and **no env-var fallbacks**. Catalog entry `slug: "fs"`
documents `root` only; `listEnvVars("fs")` and `getSecretEnvVars("fs")`
return `[]`.

Required:

- `root` — directory the adapter manages (`path.resolve` at
  construction). Missing `root` throws `FilesError("Provider", …)` at
  construction. **Created on first upload** (`mkdir` recursive on the body
  parent). `list()` before any upload returns `{ items: [] }`.

Optional:

- `urlBaseUrl` — HTTP origin for `url()` / `signedUploadUrl()`. Set →
  `joinPublicUrl(urlBaseUrl, key)`. Unset → `file://` via
  `pathToFileURL` (CLIs/tests, not browsers).
- `defaultUrlExpiresIn` — seconds for `?expires=` on `signedUploadUrl`;
  defaults to `DEFAULT_URL_EXPIRES_IN` (3600) from
  [`../internal/core.ts`](../internal/core.ts). `url()` ignores expiry.

## Storage layout and path safety

Key `avatars/a.png` maps to body `${root}/avatars/a.png` and sidecar
`${root}/avatars/a.png.meta.json`. Nested directories are created on
upload.

Sidecar fields: `contentType`, quoted `etag` (SHA-1, 16 hex chars),
`lastModified`, optional `cacheControl` / `metadata`. Written on every
`upload`; `list()` / `walk()` never yield `*.meta.json` keys. Hand-placed
bodies without sidecars still download (octet-stream, no etag). Bad JSON
→ `Provider`; partial JSON → treat as absent fields.

`delete()` removes body + sidecar (`force: true`, idempotent). `copy()`
copies sidecar with refreshed `lastModified`, or removes stale dest
sidecar when source had none.

Every key passes `resolveKeyPath(root, key)` first:

- **Traversal:** `path.resolve` + prefix guard — `..`, absolute paths,
  and out-of-root copy destinations throw `Provider`.
- **Root key:** resolving to `root` itself (e.g. `"."`) throws.
- **Sidecar keys:** resolved basename aliasing `.meta.json` throws
  (case-folded; Windows trailing dots/spaces via `FS_TRAILING_NOISE`).
  Rejects `x.txt.meta.json`, `x.txt.META.JSON`, `x.txt.meta.json/`, etc.
  Directory segments like `drafts.meta.json/note.txt` are fine.

Checks run on `signedUploadUrl` even though it does not write.

## Operation map

- `upload` — non-stream bodies via `bodyToBytes` (string, `Uint8Array`,
  `ArrayBuffer`, `ArrayBufferView` with byteOffset, `Blob`). Streams are
  fully drained to memory, written to `${bodyPath}.${pid}.${ts}.tmp`, then
  `rename`d — crash mid-write never leaves a partial body. Computes
  `sha1Etag` from bytes. Defaults: string → `text/plain; charset=utf-8`,
  `Blob.type` when set, else `application/octet-stream`. Overwrites in
  place and rewrites the sidecar.
- `download` — reads body; `as: "stream"` returns `createReadStream` via
  `Readable.toWeb`. Metadata merges sidecar with `stat.mtimeMs` when
  `lastModified` absent.
- `head` — `stat` + sidecar metadata only; body via lazy factory.
- `exists` — `existsByProbe(() => fsp.stat(bodyPath), mapFsError)`.
  `stat` on directories returns true (same permissive semantics as `head`;
  tighten both together if file-only is ever required).
- `delete` — `rm` body + sidecar with `force: true` (idempotent).
- `copy` — `copyFile` + sidecar copy or dest sidecar removal; mkdir dest
  parents.
- `list` — iterative depth-first `walk` with `withFileTypes` (no extra
  stat per dirent). Yields posix keys (`/` on Windows too), sorted,
  optional `prefix`, cursor pagination (last returned key; next page =
  first key strictly greater — same as
  [`../../test/fake-adapter.ts`](../../test/fake-adapter.ts)). Default
  `limit` 1000. ENOENT between walk and per-item `stat` skips the entry.
- `url` / `signedUploadUrl` — see below. No native `deleteMany`; `Files`
  uses `deleteManyWithFallback` from [`../internal/core.ts`](../internal/core.ts).

`mapFsError`: `ENOENT`/`ENOTDIR` → `NotFound`; `EACCES`/`EPERM` →
`Unauthorized`; `EEXIST` → `Conflict`; else `Provider`. Preserves
`FilesError`; non-`Error` throws map to `"fs error"` for `Provider`.

## URL and signed upload behavior

**Without `urlBaseUrl`:** `url(key)` → `file://` body path (no existence
stat). `responseContentDisposition` throws — no signature to bind
(stored-XSS stance, same as vercel-blob / supabase).

**With `urlBaseUrl`:** `url(key)` → `joinPublicUrl`. Disposition appends
`?response-content-disposition=` (or `&` if base has query); dev server
must honor it.

**`signedUploadUrl`:** requires `urlBaseUrl` or throws (no built-in
upload server — wire a dev handler to the same `root`). Returns PUT URL:
`${joinPublicUrl(urlBaseUrl, key)}?expires=<unix>` plus optional
`content-type`, `max-size` query params and `Content-Type` header.
Expiry is **not enforced** by the adapter; handlers may validate
`expires`. `defaultUrlExpiresIn` / per-call `expiresIn` only shape the
query. Serve and upload origins can differ (e.g. `/files` vs `/upload`).

## Provider quirks worth remembering

- Dev/test only — no replication, locking, versioning, or multi-tenant
  isolation beyond the `root` directory boundary.
- ETag is upload-time SHA-1 (16 hex chars, quoted), not inode-based.
  Re-uploading identical bytes yields the same etag; editing a body file
  by hand without updating the sidecar leaves stale metadata until the
  next SDK `upload`.
- Stream uploads buffer entirely in memory before disk write — fine for
  dev payloads, not for multi-GB objects.
- `url()` without `urlBaseUrl` does not stat the path first; a `file://`
  URL for a missing key 404s at fetch time, matching cloud adapters that
  return URLs for deleted objects.
- `signedUploadUrl` and `url` can point at different `urlBaseUrl` values
  in separate adapter instances if serve and upload handlers differ.
- Sidecars survive `cp -r` / `git mv` / partial tree copies; deleting
  only the body externally orphans the sidecar until manual cleanup.

## Testing approach

[`../../test/fs.test.ts`](../../test/fs.test.ts) uses real `mkdtemp`
dirs under `os.tmpdir()`, removed in `afterAll` — no SDK mocks. Covers:

- Construction: missing `root`, absolute resolved `root`, `name` / `raw`.
- Upload/download: string, `Uint8Array`, `Blob`, `ArrayBuffer`,
  `DataView` (byteOffset), explicit `contentType`, metadata/cacheControl
  sidecar shape, nested keys, stream upload, overwrite, download stream.
- `head` lazy body, `exists`, idempotent `delete`, `copy` (+ NotFound src).
- `list`: sort order, prefix, limit+cursor pages, sidecar exclusion, empty
  root before first upload, ENOENT mid-page skip, EACCES walk error.
- Path safety: `..`, absolute paths, root key, `.meta.json` suffix and host
  aliases (`META.JSON`, trailing dot/space/slash), allowed dir segment
  `drafts.meta.json/note.txt`.
- `url`: `file://`, `urlBaseUrl`, trailing-slash trim, disposition query.
- `signedUploadUrl`: requires `urlBaseUrl`, PUT + `expires` / `content-type`
  / `max-size` query, traversal rejected at sign time.
- `mapFsError` table; malformed sidecar JSON; upload temp cleanup on
  failed rename (buffer and stream paths).

Add fs-specific cases here, not in cloud adapter tests.

## Coding conventions

- Named exports only. Construction errors → `FilesError("Provider", …)`.
- `createStoredFile` for every `StoredFile`; `existsByProbe` /
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts).
- List keys are posix `/`; body paths use `path.join` on split segments.
- `FS_TRAILING_NOISE` stays a top-level regex (ReDoS-safe).
- `bestEffortRm` is intentionally silent in cleanup paths.
- No `readEnv` — nothing to read from `process.env`.

## Releases

Ships with the monorepo [`package.json`](../../package.json). Behavioral
changes need a Changesets entry; docs/tests-only do not.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts).
- `FilesError`: [`../internal/errors.ts`](../internal/errors.ts).
- `StoredFile`: [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Provider catalog (`slug: "fs"`): [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/fs.mdx`](../../../../apps/web/content/docs/adapters/fs.mdx).
- README: [`../../README.md`](../../README.md).
- SKILL: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/fs.test.ts`](../../test/fs.test.ts).
