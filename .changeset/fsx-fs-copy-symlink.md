---
"files-sdk": patch
---

`files-sdk/fs` `copy()` now stages the copied body (and its sidecar) next to the destination and renames it into place, like `upload()`. Previously it wrote straight to the destination path, so a symlink already sitting at the destination key or its `.meta.json` sidecar was followed and the file it pointed at, even one outside the adapter root, was overwritten; a crash mid-copy could also leave a truncated body or sidecar behind.
