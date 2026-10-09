---
"files-sdk": patch
---

`sync(source, dest, { prune: true, signal })` no longer deletes destination keys after the caller aborts. The prune's bulk `delete` takes no signal, so an abort during the upload phase still let the whole prune run. When a `signal` is passed, the prune now runs in batches of up to 100 keys and checks the signal before each one. Once it's aborted, no further key is deleted, and the keys left unpruned come back in `errors` as aborted `FilesError`s and are reported to `onProgress` as `"failed"`, the same way aborted uploads are, so `done` still reaches `total`. Without a `signal`, the prune is still a single bulk `delete`.
