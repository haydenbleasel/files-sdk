# AGENTS.md — `files-sdk/bunny-storage`

Guidance for coding agents working on the `bunny-storage` adapter. The
unified `Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only bunny-storage
deviations. `bunnyStorage()` is a **native** adapter: it talks directly to
[Bunny Storage](https://bunny.net/storage) through
[`@bunny.net/storage-sdk`](https://www.npmjs.com/package/@bunny.net/storage-sdk),
not through an S3-compatible endpoint. Cross-references:
[`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

One connected storage zone per adapter instance (`zone.connect_with_accesskey`).
Every method calls a Bunny primitive (`file.upload`, `file.get`,
`file.list`, `file.remove`). There is no server-side copy, no presigned
read URL, and no presigned upload URL in the Bunny Storage API — the
adapter surfaces those gaps honestly (`copy` read-then-writes,
`signedUploadUrl` throws, `url` needs a CDN origin). Upload metadata
round-trips via a post-PUT `file.get` because Bunny's PUT response carries
no body. Listing is directory-scoped (one `file.list` per parent path),
with client-side prefix filtering and numeric cursor pagination layered
on top. The returned adapter exposes `name: "bunny-storage"`, a readonly
`zone` string, and `raw` as the connected `StorageZone` client.

Peer dependency (optional, in
[`../../package.json`](../../package.json)): `@bunny.net/storage-sdk`.

## Directory layout

```text
packages/files-sdk/src/bunny-storage/
├── index.ts     # bunnyStorage() factory + mapBunnyStorageError + keyFromStorageFile
├── AGENTS.md    # this file
└── CLAUDE.md    # @AGENTS.md indirection
```

Tests: [`../../test/bunny-storage.test.ts`](../../test/bunny-storage.test.ts).
User docs:
[`../../../../apps/web/content/docs/adapters/bunny-storage.mdx`](../../../../apps/web/content/docs/adapters/bunny-storage.mdx).
Provider catalog:
[`../providers/index.ts`](../providers/index.ts) under `slug: "bunny-storage"`.

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/bunny-storage.test.ts   # this adapter's tests
bun test                               # full suite
bun run build                          # tsup → dist/bunny-storage/
bun run types                          # tsgo --noEmit
```

`bun test` (not vitest) and `tsgo` (not `tsc`) are pinned. The
`bunny-storage` subpath is in [`../../package.json`](../../package.json)'s
`exports` map — keep it in sync if the layout changes.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `bunnyStorage(opts?: BunnyStorageAdapterOptions): BunnyStorageAdapter` —
  factory. Throws `FilesError("Provider", …)` when `zone` + `accessKey` +
  `region` cannot be resolved (unless `client` is passed).
- `BunnyStorageAdapterOptions` — `zone`, `accessKey`, `region`, `client`,
  `publicBaseUrl`. JSDoc on every field is the source of truth; the docs
  MDX pulls it via `<AutoTypeTable>`.
- `BunnyStorageAdapter` — `Adapter<BunnyStorageClient> & { readonly zone }`.
  `BunnyStorageClient` is `ReturnType<typeof zone.connect_with_accesskey>`.
- `BunnyStorageRegion` — template type over
  `BunnyStorageSDK.regions.StorageRegion` (`"de"`, `"ny"`, `"syd"`, …).
- `mapBunnyStorageError(err): FilesError` — exported for callers reusing
  the same classification on errors from `raw`.

## Authentication / configuration

Three resolution paths, in precedence order:

1. **`opts.client`** — an already-connected storage zone from
   `@bunny.net/storage-sdk`. When set, `zone`, `accessKey`, and `region`
   are ignored and no env vars are read. `adapter.zone` comes from
   `zone.name(client)`.
2. **Explicit options** — `zone` + `accessKey` + `region`, passed to
   `zone.connect_with_accesskey(region, zone, accessKey)`. `accessKey` is
   the Storage Zone **password** (Bunny's console label), not an account
   API key.
3. **Env fallbacks** — via [`readEnv`](../internal/env.ts):
   - Zone: `BUNNY_STORAGE_ZONE`, then `STORAGE_ZONE`.
   - Access key: `BUNNY_STORAGE_ACCESS_KEY`, then `STORAGE_ACCESS_KEY`.
   - Region: `BUNNY_STORAGE_REGION`, then `STORAGE_REGION`.

Missing any of the trio throws at construction with a message naming both
the `BUNNY_STORAGE_*` and `STORAGE_*` aliases. Invalid `region` strings
throw before connect — valid codes are whatever
`Object.values(BunnyStorageSDK.regions.StorageRegion)` contains today
(`de`, `jh`, `uk`, `la`, `ny`, `br`, `sg`, `se`, `syd`, …).

Optional:

- **`publicBaseUrl`** — origin for `url()` (typically a Bunny **Pull
  Zone** or custom CDN hostname in front of the Storage Zone). Without it,
  `url()` throws: the raw Storage API URL requires an `AccessKey` header
  and cannot be handed out as a public link.

The provider catalog entry under `slug: "bunny-storage"` in
[`../providers/index.ts`](../providers/index.ts) mirrors the env layout:
required zone, credential-mode access key, optional region.

## Operation map

All operations route errors through `mapBunnyStorageError`. Keys are
zone-relative strings; the adapter prefixes Bunny paths with `/` via
`toBunnyPath` / `fromBunnyPath`.

- **`upload`** — `file.upload` then `file.get` for authoritative
  `etag` / `lastModified` / `size` (streamed uploads may not know size
  upfront). Body goes through shared
  [`normalizeBody`](../internal/core.ts). `assertSupportedUploadOptions`
  runs first (see quirks). If the post-upload `get` fails, returns a
  fallback `UploadResult` from the normalized body.
- **`download`** — `file.get` → `entry.data()`. `as: "stream"` returns a
  lazy stream `StoredFile`; default buffers via `bytesFromStream`.
- **`head`** — `file.get` without eagerly fetching bytes; body accessors
  lazy-call `entry.data()`.
- **`exists`** — [`existsByProbe`](../internal/core.ts) wrapping
  `file.get`; `NotFound` → `false`.
- **`delete`** — `file.remove`. The Bunny SDK returns `response.ok` and
  does **not** throw on 4xx — missing keys delete idempotently. Only
  network-layer failures reach the catch.
- **`copy`** — `file.get(from)` → stream → `file.upload(to, …)` with the
  source `contentType`. Not atomic; no server-side copy in the SDK.
- **`list`** — `file.list(client, listDirectoryForPrefix(prefix))`,
  filters out `isDirectory` entries, maps via `keyFromStorageFile`, then
  client-side `prefix` filter and numeric `cursor`/`limit` slicing.
  Emits `cursor` only when more items remain. **Shallow only:** a prefix
  like `docs/` lists immediate children of `/docs/`, not recursive
  descendants — nested keys under `docs/2024/` do not appear when listing
  `docs/`.
- **`signedUploadUrl`** — always rejects with `FilesError("Provider", …)`.
  Bunny writes require the Storage API `AccessKey` header; proxy uploads
  through your app or call `raw` directly.

## URL behavior

Bunny Storage has **no signed-read primitive**. `url(key, opts?)` does not
call the Storage API and does not honor `expiresIn` (there is nothing to
expire).

- **`publicBaseUrl` required** — returns
  [`joinPublicUrl(publicBaseUrl, key)`](../internal/core.ts) (URL-encodes
  path segments). Permanent CDN URL; configure TTL and cache on the Pull
  Zone, not in this adapter.
- **`publicBaseUrl` absent** — throws `Provider` with guidance to set a
  Pull Zone / CDN origin.
- **`opts.responseContentDisposition`** — throws `Provider`. Unlike S3
  adapters, there is no signature to bind a Content-Disposition override;
  silently ignoring it would be a stored-XSS regression on user-uploaded
  HTML/SVG.

There is no `defaultUrlExpiresIn` option — nothing to sign.

## Provider quirks worth remembering

- **Storage Zone password auth.** `accessKey` is the zone password from
  the Bunny dashboard (*FTP & API Access* → *Password*). Every Storage API
  request carries it; treat it like a secret.
- **Region picks the Storage API host.** Must match where the zone was
  created. Wrong region → auth or routing failures before object I/O.
- **CDN is separate from Storage.** Reads for end users almost always go
  through a Pull Zone (`publicBaseUrl`). The Storage hostname itself is
  not a public URL.
- **Custom `metadata` throws.** Non-empty `UploadOptions.metadata` →
  `FilesError("Provider", …)`. Bunny has no arbitrary metadata primitive.
  An empty `{}` is allowed (no keys → no throw).
- **`cacheControl` throws.** Configure cache behavior on the Pull Zone /
  CDN, not per-object via Storage API.
- **`copy` is read-then-write.** Large objects stream through your runtime;
  not atomic; concurrent writes to the source between get and put are not
  detected.
- **`keyFromStorageFile` is the fragile center.** Bunny returns `Path`
  (directory, zone-prefixed, usually trailing `/`) and `ObjectName`
  (filename). The adapter strips the zone segment and joins carefully —
  including defensive branches when `Path` already contains the full key
  or when a filename equals its parent directory name. The trailing-slash
  detector uses `(?<!\/)\/+$` to avoid ReDoS on long slash runs. Touch this
  only with regression tests from
  [`../../test/bunny-storage.test.ts`](../../test/bunny-storage.test.ts).
- **Error mapping is message-regex based.** `@bunny.net/storage-sdk` throws
  plain `Error` with English text, not structured codes. `mapBunnyStorageError`
  regex-matches `not found`, `unauthor|access key|forbidden`, and
  `conflict|precondition`, plus explicit `code` when present. Localization
  or rephrasing would silently degrade to `Provider`.
- **`etag` comes from Bunny `checksum`.** May be null; surfaced when present.

## Testing approach

[`../../test/bunny-storage.test.ts`](../../test/bunny-storage.test.ts)
mocks `@bunny.net/storage-sdk` with an in-memory `Map` backing store and
hand-built `StorageFile` shapes that mirror real Bunny semantics
(`Path: "/<zone>/<dir>/"`, `ObjectName: "<file>"`). Coverage includes:

- Construction: missing credentials, env fallbacks (`BUNNY_STORAGE_*` and
  `STORAGE_*`), explicit options overriding env, `client` bypass, invalid
  region.
- Upload: round-trip metadata, head fallback on transient `get` failure,
  `cacheControl` / metadata throws, empty metadata allowed, all `Body`
  variants including unknown-length streams.
- Download / head / exists / list (prefix, limit, cursor, shallow listing,
  zone-prefix stripping, `keyFromStorageFile` edge cases).
- Copy (content-type preservation, missing source → `NotFound`), delete
  idempotency, `url` / `signedUploadUrl` throws, `mapBunnyStorageError`
  classification.

Add fixtures here, not in a generic storage test, whenever behavior
depends on Bunny path semantics or SDK message shapes.

## Coding conventions

- Named exports only — `bunnyStorage`, `mapBunnyStorageError`, types.
- Construction-time and capability gaps throw
  [`FilesError("Provider", …)`](../internal/errors.ts) with the
  `bunnyStorage:` prefix so logs stay grep-friendly. Operation errors wrap
  via `mapBunnyStorageError`; existing `FilesError` instances pass through.
- Read env via [`readEnv`](../internal/env.ts); never `process.env`
  directly (Workers without `nodejs_compat`).
- Use shared [`normalizeBody`](../internal/core.ts) and
  [`createStoredFile`](../internal/stored-file.ts) — don't hand-roll
  `StoredFile` bodies.
- Top-level regex literals only (`toBunnyPath`, `keyFromStorageFile`). Keep
  the `(?<!\/)` anchor when trimming trailing slashes.
- Cast Bunny stream types at the boundary (`as unknown as ReadableStream`)
  — the SDK's stream typing is narrower than WHATWG streams the adapter
  accepts.

## Releases

Ships on the monorepo Changesets schedule. Behavioral changes need a
changeset; AGENTS.md / CLAUDE.md / test-only edits do not. Peer dep
`@bunny.net/storage-sdk` is declared optional — document version bumps in
CHANGELOG when the adapter starts requiring newer SDK behavior.

## Where to look next

- Source: [`./index.ts`](./index.ts).
- Tests: [`../../test/bunny-storage.test.ts`](../../test/bunny-storage.test.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/bunny-storage.mdx`](../../../../apps/web/content/docs/adapters/bunny-storage.mdx).
- Unified contract: [`../index.ts`](../index.ts).
- Shared helpers:
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Provider catalog (search `slug: "bunny-storage"`):
  [`../providers/index.ts`](../providers/index.ts).
- CLI registry: [`../cli/registry.ts`](../cli/registry.ts).
- README + SKILL: [`../../README.md`](../../README.md),
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
