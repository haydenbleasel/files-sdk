---
"files-sdk": patch
---

`files-sdk/bunny-storage` now percent-encodes each key segment in the Storage API path. The Bunny SDK puts the path into the request URL unencoded, so a key containing `%` followed by two hex digits was written under its decoded name (`a%20b.txt` became `a b.txt`), a `\` became a `/`, and tabs and newlines were dropped.
