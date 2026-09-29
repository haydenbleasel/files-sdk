---
"files-sdk": patch
---

`files-sdk/api` now binds each keyless-upload token to the endpoint path that minted it, and the proxy upload and `complete` steps refuse a token presented at any other path. Previously the token was bound only to the endpoint's query, so with two gateways sharing one secret (the `FILES_API_SECRET` default, as in the one-route-per-bucket setup), a token presigned at one route could be replayed against the other route's `?op=proxy` upload. That wrote bytes into the second route's bucket, outside its `keyPrefix`, even though its `authorize` and `operations` never approved an upload.
