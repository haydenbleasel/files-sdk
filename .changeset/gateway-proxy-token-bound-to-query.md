---
"files-sdk": patch
---

The gateway's presign upload tokens are now bound to the endpoint query they were minted under. With a per-request `files` factory that picks the instance from the query string (the `?bucket=` pattern), a token minted under one bucket could previously be replayed against the proxy upload endpoint with the bucket switched, and the bytes landed in an instance where `authorize` would have refused the upload; the `PUT ?op=proxy` path never re-ran `authorize` and the token carried no memory of the query. The token now records the request's non-routing query (everything except `op`, `key`, and `token`, in a canonical sorted form), and both the proxy upload and `complete` refuse a token presented under a different query with a 401 `Unauthorized` error. Single-bucket gateways with a bare endpoint are unaffected: an empty bound query matches an empty query.
