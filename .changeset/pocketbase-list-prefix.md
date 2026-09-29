---
"files-sdk": patch
---

`files-sdk/pocketbase` `list({ prefix })` now returns only keys that start with the prefix exactly. PocketBase runs the `~` filter as SQL `LIKE`, so `_` and `%` in the prefix acted as wildcards and letters matched case-insensitively (`prefix: "A_"` returned `a1.txt`). The server filter still narrows the page, and the adapter now matches the prefix exactly on the results, so a page can hold fewer than `limit` items.
