---
"files-sdk": minor
---

Add an upload lifecycle hook to the gateway (`files-sdk/api`). `createFilesRouter({ onUploadComplete })` runs on the server once per verified upload: in `complete` for keyless uploads, after the gateway `head`s the landed object and checks `maxUploadSize`, and after a keyed `upload(key, body)` stores its body. Record the upload there instead of building a second endpoint and trusting the client to call it. The hook receives the caller-facing `file` metadata, its `storageKey`, the request, a stable `uploadId` and how the bytes arrived (`via`). `authorize` can now return `context` (the signed-in user, say), which reaches the hook typed.

Whatever the hook returns comes back to the browser as the upload result's `data`, in `createFilesClient`, the React, Vue and Svelte `useFiles` bindings (results and `uploads` entries), and the registry `Dropzone` / `MultipartUploader` `onUploaded` callbacks. Type it with `useFiles<InferUploadData<typeof router>>()`.

Throwing from the hook rejects the upload: the gateway deletes the object and the client's `upload()` rejects with the error (`UploadRejectedError` gives a 422 with your message). A removal that fails is reported alongside the rejection. Set `onRejected: "keep"` to keep rejected objects, including ones the complete-time `maxUploadSize` check refuses. Upload tokens are stateless, so a replayed `complete` fires the hook again with the same `uploadId`; pass a `completions` store to make completions single-use.
