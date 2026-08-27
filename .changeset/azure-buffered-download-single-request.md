---
"files-sdk": patch
---

Fix `azure()` buffered `download()` opening a GET whose body was never read or destroyed before issuing the real `downloadToBuffer` request, which held the first response's socket open until garbage collection. The adapter now fetches the metadata with a lightweight `getProperties()` call instead; the returned file is unchanged.
