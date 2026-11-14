---
"files-sdk": patch
---

A plugin's `next()` now always returns a promise. When the core refused the operation synchronously (an invalid key, an unsupported `range`, a changed conditional predicate) or an inner plugin's `wrap` threw before returning, `next()` threw instead of rejecting, so a plugin written as `next(op).catch(...)` or `next(op).finally(...)` never ran its handler or cleanup.
