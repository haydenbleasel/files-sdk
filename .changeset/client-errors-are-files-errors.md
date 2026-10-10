---
"files-sdk": patch
---

`files-sdk/client` and the `useFiles` bindings (`files-sdk/react`, `files-sdk/vue`, `files-sdk/svelte`) now reject with a `FilesError` when a request never gets an answer. A network failure used to surface as the runtime's bare `TypeError` and a cancelled call as a raw `AbortError`, and the hooks recorded a hook-level `abort()` in `error` as a `Provider` failure with `aborted: false`. A network failure is now a `Provider` `FilesError` with the original error as its `cause`, and a cancelled call (per-call `signal`, hook-level `signal`, or `abort()`) is flagged `aborted: true`, matching the XHR upload path. The hooks rethrow the same error they record in `error`.
