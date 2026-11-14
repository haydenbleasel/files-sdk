---
"files-sdk": patch
---

`files-sdk/dedup` now releases a pointer's body before following it to the blob. A `download(key, { as: "stream" })` (which is how the `files-sdk/api` gateway proxies downloads) fetched the pointer as a live stream and never read or cancelled it, so on S3-style adapters every de-duplicated download left a provider connection open until the pool ran out.
