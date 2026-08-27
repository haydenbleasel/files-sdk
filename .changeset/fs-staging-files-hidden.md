---
"files-sdk": patch
---

The fs adapter's in-flight upload staging files no longer surface as objects. A crash between writing the staging file and renaming it into place, or a `list()` racing an upload, used to expose a `<key>.<pid>.<ms>.tmp` entry whose download served half-written bytes. Staging files now use the reserved `.fls-tmp` suffix, which `list()` skips and which keys can no longer target, alongside the existing `.meta.json` and `.fls-part` reservations.
