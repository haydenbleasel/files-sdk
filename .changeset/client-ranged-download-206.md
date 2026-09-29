---
"files-sdk": patch
---

`files-sdk/client` `download(key, { range })` now rejects when the response isn't `206 Partial Content`. A gateway or storage host that ignores `Range` answers `200` with the whole object, which was returned as if it were the requested slice. This matches the server SDK.
