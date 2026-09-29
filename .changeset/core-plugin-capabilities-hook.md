---
"files-sdk": patch
---

Plugins can now narrow what `files.capabilities` advertises through an optional `capabilities(caps)` hook on `FilesPlugin`. The `Files#capabilities` getter folds every installed plugin's hook over the adapter-derived snapshot in `plugins` order (read-only clones from `files.readonly()` keep the narrowing), so a plugin that can't honor presigned URLs or byte ranges end to end can say so up front instead of only failing at call time. The snapshot's `signedUrl` is now a copy, so a hook can't rewrite the adapter's own declaration.
