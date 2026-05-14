---
"files-sdk": patch
---

URL-encode keys in `joinPublicUrl` to prevent injection attacks via special characters (`?`, `#`, spaces) in file keys. Uses segment-by-segment encoding to preserve `/` as a path separator.

**Note:** Pass raw keys — this function handles encoding. Pre-encoded keys will be double-encoded (e.g. `%20` becomes `%2520`).
