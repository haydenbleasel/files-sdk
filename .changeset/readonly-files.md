---
"files-sdk": minor
---

Add read-only `Files` instances.

Pass `readonly: true` to the constructor, or derive a locked view from an existing client with `files.readonly()`, when a caller should be able to read storage but never mutate it:

```ts
const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  readonly: true,
});

const readOnly = files.readonly(); // reuses the same adapter, prefix, timeout, retries, and hooks
```

Reads stay available (`download`, `head`, `exists`, `list`, `listAll`, `url`). Every write surface — `upload`, `delete`, `copy`, `move`, `signedUploadUrl`, and the equivalent `file(key)` helpers (`upload`, `delete`, `copyTo`, `copyFrom`, `moveTo`, `moveFrom`, `signedUploadUrl`) — now fails immediately, before the adapter is touched, with a new normalized `FilesError { code: "ReadOnly" }`. The failure is deterministic and is not retried; `onError` and the final `onAction({ status: "error" })` hooks still fire.

The `raw` escape hatch is not governed by the guard — code that writes through `files.raw` bypasses it by design.
