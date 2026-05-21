---
"files-sdk": minor
---

Add a Convex storage adapter (`files-sdk/convex`). Convex file storage is only reachable from inside a Convex function, so the adapter wraps the function context — `convex({ ctx })`, constructed per request inside an action, mutation, or query — and maps the unified `Adapter` surface onto `ctx.storage` / `ctx.db.system`. Because Convex assigns the storage id (`Id<"_storage">`) and exposes no writable metadata, the storage id is the key: `upload()` returns the assigned id, and `download`/`head`/`delete`/`url` take it back. Available operations follow Convex's context rules — `upload`/`download` need an action, `list` needs a query/mutation — and the adapter throws a descriptive error when a primitive is unavailable. `copy`, custom `metadata`, and `cacheControl` are unsupported; `url()` returns a permanent serving URL; `signedUploadUrl()` returns Convex's raw-body POST upload URL. `convex` is an optional peer dependency.
