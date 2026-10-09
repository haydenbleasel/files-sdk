---
"files-sdk": patch
---

The in-memory adapter (`files-sdk/memory`) now refuses `url(key, { expiresIn })` with `Unsupported` when the adapter is called directly. This matches `capabilities.signedUrl.supported: false`. Before, it returned a `memory://…?expires=` URL. Calls through `Files` were already refused before they reached the adapter.
