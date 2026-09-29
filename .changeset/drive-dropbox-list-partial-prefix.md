---
"files-sdk": patch
---

`files-sdk/dropbox` now lists the folder a `prefix` points into when `list()` is called with a `delimiter`. The whole prefix used to be read as a folder path, so a prefix without a trailing `/` came back wrong: `photos/20` listed nothing instead of `photos/2023/` and `photos/2024/`, and `photos/2024` returned that folder's children instead of the common prefix `photos/2024/`. The part of the prefix up to its last `/` now picks the folder and the whole prefix filters its children, matching the other adapters.
