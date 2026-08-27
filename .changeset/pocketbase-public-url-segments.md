---
"files-sdk": patch
---

Fixed the PocketBase adapter's `url()` percent-encoding the slashes of nested keys (`docs/a.txt` became `docs%2Fa.txt`) when `publicBaseUrl` is configured. Keys are now encoded per path segment, matching every other adapter.
