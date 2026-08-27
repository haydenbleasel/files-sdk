---
"files-sdk": patch
---

Dropbox `url()` on a public shared link now rewrites `dl=0` to `dl=1` correctly on current `/scl/fi/...?rlkey=...&dl=0` links. The old rewrite matched the literal `?dl=0` prefix, which no longer comes first on these links, and appended a second parameter, yielding `...&dl=0&dl=1` and serving the preview page instead of the raw bytes. The parameter is now set through the URL parser regardless of its position.
