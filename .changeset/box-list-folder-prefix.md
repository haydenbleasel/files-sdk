---
"files-sdk": patch
---

`files-sdk/box` now lists the folder a `prefix` points into. `list()` only ever read `rootFolderId` and compared the whole prefix against child names, so `list({ prefix: "photos/", delimiter: "/" })` came back empty, the folder prefixes it returned led nowhere, and a `Files` client `prefix` listed nothing. The part of the prefix up to its last `/` now picks the folder (resolved under `rootFolderId`), the rest filters child names, and keys come back in full (`photos/cover.jpg`); a prefix into a missing folder lists nothing.
