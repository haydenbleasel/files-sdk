---
"files-sdk": patch
---

The default upload transport in `files-sdk/client` (and so in `files-sdk/react`, `files-sdk/vue` and `files-sdk/svelte`) now removes its abort listener from the caller's signal once each `XMLHttpRequest` settles. Previously a long-lived signal shared across many uploads kept a listener, and with it every finished request and its response, alive until the signal was aborted or collected.
