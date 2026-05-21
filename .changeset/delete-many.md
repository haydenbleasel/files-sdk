---
"files-sdk": patch
---

Add `deleteMany(keys, options?)` for bulk deletion. It returns a structured `{ deleted, errors? }` result instead of throwing on partial failure, so you can remove many keys in one call and still see exactly which ones failed:

```ts
const result = await files.deleteMany(
  ["avatars/a.png", "avatars/b.png", "avatars/c.png"],
  { concurrency: 8, stopOnError: false }
);

result.deleted; // string[] — keys removed, in the order supplied
result.errors; // undefined when every key succeeded
```

Adapters with a native bulk primitive use it — S3 sends `DeleteObjects` (chunked into batches of 1000, the provider limit), Supabase uses `remove(keys)`, and UploadThing uses `deleteFiles(keys)` — while every other adapter fans out to `delete()` with bounded `concurrency` (default 8). `stopOnError: false` (default) attempts every key and collects per-key failures in `errors`; `stopOnError: true` stops at the first failure. Invalid keys are reported in `errors` rather than thrown, and like `delete`, `deleteMany` honors the client's `prefix` and is no-op friendly on providers that treat a missing key as success.
