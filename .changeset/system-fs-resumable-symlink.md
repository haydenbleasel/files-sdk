---
"files-sdk": patch
---

`files-sdk/fs` resumable uploads no longer follow a symlink planted at the `<key>.fls-part` staging path. Starting an upload used to open that path and truncate whatever the link pointed at, inside the root or not, and completing it then renamed the link into place. Now the upload replaces anything at the staging path and creates the file exclusively, and a chunk or completion that finds a symlink there fails with `Conflict` instead of writing or reading through it.
