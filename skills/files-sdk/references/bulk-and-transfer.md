# Bulk operations, move, listAll & transfer

Acting on many objects, renaming, walking a whole bucket, and migrating across providers.

## Bulk (array) forms

`upload`, `download`, `head`, and `exists` take a single key **or an array**; `delete` takes one key or many. The array form fans out with bounded concurrency (8 by default) and **does not throw on partial failure** — successes and failures come back separated, in input order.

```ts
const { uploaded, errors } = await files.upload([
  { key: "a.txt", body: "alpha" },
  { key: "b.txt", body: "beta", contentType: "text/plain", multipart: true },
]);

const { existing, missing } = await files.exists(["a.txt", "b.txt", "c.txt"]);
const { files: metas } = await files.head(["a.txt", "b.txt"]);
const { downloaded } = await files.download(["a.txt", "b.txt"]);
const { deleted } = await files.delete(["a.txt", "b.txt"]);
```

| Method     | Array form returns               |
| ---------- | -------------------------------- |
| `upload`   | `{ uploaded, errors? }`          |
| `download` | `{ downloaded, errors? }`        |
| `head`     | `{ files, errors? }`             |
| `exists`   | `{ existing, missing, errors? }` |
| `delete`   | `{ deleted, errors? }`           |

The success arrays are in supplied order. Each `errors` entry is `{ key, error }` with a normalized `FilesError`; invalid keys (empty, null bytes) are reported there too, never thrown. `errors` is omitted entirely when every item succeeded.

### Options & semantics

- **`concurrency`** (default 8) — how many per-key ops run in parallel.
- **`stopOnError: true`** — bail at the first failure, returning results gathered so far plus that error. Runs **sequentially** (ignores `concurrency`).
- **No `signal` or `retries`** — bulk calls aren't retried (`onRetry` never fires) and don't take a per-call signal; re-drive failed keys from `errors[]` instead. Cancellation/retries are single-key concerns.
- **Native batch delete:** `delete([...])` uses a provider's native bulk primitive where it has one (S3 `DeleteObjects` chunked at 1000, Supabase, UploadThing) and ignores `concurrency`; others fall back to bounded fan-out. The other four methods always fan out (no provider batch primitive).
- **Hooks:** one aggregated `onAction` per call (carries `keys` + the aggregated result; per-item failures live in `result.errors`, not `onError`).
- **`prefix`** is honored throughout — resolved on the way in, stripped on the way out.

```ts
const result = await files.upload(items, { concurrency: 16 });
if (result.errors) {
  for (const { key, error } of result.errors)
    logger.warn("upload failed", key, error.code);
}
```

## `move`

```ts
await files.move("uploads/tmp-abc.png", "avatars/user-123.png");
// FileHandle equivalents:
await files.file("avatars/user-123.png").moveFrom("uploads/tmp-abc.png");
```

Uses the adapter's native rename where one exists (`fs` renames in place atomically; Cloudinary uses server-side `rename`, keeping the same `asset_id` with no re-upload) and otherwise falls back to `copy` + `delete` — the same two-step every object store takes (none offer an atomic move). Moving a key onto itself is a no-op, so the fallback can't delete a file out of existence. **Throws on Convex** (immutable storage ids, no rename), where `copy` also throws. Fires the lifecycle hooks with a `"move"` action type (`from`/`to`).

## `listAll`

Walk every page as an async iterable — the SDK follows the cursor for you:

```ts
for await (const file of files.listAll({ prefix: "avatars/" })) {
  console.log(file.key, file.size);
}
```

`prefix` scopes the walk, `limit` sets the per-page size. Each page is a real `list` call, so retries, timeouts, and prefix scoping apply. (This is the engine `transfer` walks the source with.)

## Folder listing (`delimiter`)

`list({ delimiter })` collapses keys at the boundary into S3-style common prefixes — the building block for a file-browser UI.

```ts
const { items, prefixes } = await files.list({
  prefix: "photos/",
  delimiter: "/",
});
// items    → direct files:    [ photos/cover.jpg, ... ]
// prefixes → subfolders:       [ "photos/2023/", "photos/2024/" ]   (full keys, trailing delimiter)
```

`ListResult.prefixes` is omitted when no delimiter is set or none are found; when the instance has a `prefix`, prefixes are scoped/stripped like item keys. **Supported** by object stores and folder-based providers (the latter only accept `"/"`); **throws** a `FilesError` on flat stores (UploadThing, Appwrite, PocketBase, Convex, bun-s3) — check `adapter.supportsDelimiter`. A cursor is valid only for the exact `prefix` **and** `delimiter` it was produced with — hold both constant across a paginated sequence.

## `transfer` — cross-provider migration

`copy`/`move` live inside one adapter; a migration spans two. `transfer(source, dest, options?)` walks every object the `source` exposes and streams each one straight to the `dest`. Both arguments are full `Files` instances (not raw adapters), so each leg honors its own `prefix`, retries, timeouts, and hooks. Built entirely on public primitives (`listAll` + streaming `download` on the source, `exists` + `upload` on the dest) — no adapter implements anything new.

```ts
import { Files, transfer } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { r2 } from "files-sdk/r2";

const from = new Files({ adapter: s3({ bucket: "old" }) });
const to = new Files({
  adapter: r2({ bucket: "new", accountId, accessKeyId, secretAccessKey }),
});

const { transferred, skipped, errors } = await transfer(from, to, {
  prefix: "uploads/", // only walk keys under this logical prefix
  transformKey: (key) => `archive/${key}`, // remap each key for the destination
  overwrite: false, // skip keys already at the dest (one extra exists() each)
  concurrency: 16, // objects streaming at once (default 8)
  stopOnError: false, // true → sequential, bail at first failure
  onProgress: ({ done, key, status }) => console.log(done, key, status),
});
```

| Field         | Contents                                                        |
| ------------- | --------------------------------------------------------------- |
| `transferred` | Source keys copied to the destination.                          |
| `skipped`     | Keys skipped because they already existed. Omitted when none.   |
| `errors`      | Per-key `{ key, error }` failures. Omitted when every key wins. |

Each object is streamed download-to-upload — the destination never buffers a whole large file. **Body, content type, and user metadata travel; `etag`/`lastModified` are destination-assigned and `Cache-Control` is not carried.** Metadata a destination adapter rejects (Bunny, Appwrite, PocketBase) surfaces as a per-key error rather than failing the run. Like the bulk forms, `transfer` doesn't throw on partial failure. `transformKey` maps the _logical_ key (each instance applies its own `prefix` independently). There's no `total` in progress — the source is walked lazily. Also exposed as the CLI `transfer` command and an MCP `transfer` tool (with `--allow-writes`).
