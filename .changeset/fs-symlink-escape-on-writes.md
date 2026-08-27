---
"files-sdk": patch
---

The fs adapter's write paths now enforce the same symlink boundary as its read paths. `upload`, `delete`, `move`, `copy` (destination), and resumable uploads previously followed a symlinked directory inside the root to wherever it pointed, so a link to a directory outside the root let a key write or unlink files there even though `download`/`head`/`exists` rejected the same key. Those operations now resolve the nearest existing ancestor through symlinks before touching anything, and reject keys that resolve outside the adapter root with the existing "resolves outside adapter root" `Provider` error.
