---
"files-sdk": patch
---

Security: the `files-sdk/api` gateway's `complete` step now checks that an upload token was issued for the caller. It verified the token's signature but never compared its key against the calling request's authorized `keyPrefix`, so one tenant could complete another tenant's token and read back that upload's full storage key and metadata. A token whose key lies outside the caller's prefix now gets an `Unauthorized` entry ("upload token was not issued for this caller") that echoes only the key the caller sent. The proxy upload `PUT` is unchanged: like a presigned URL, its token alone authorizes writing the one key `presign` minted until it expires, and the authorization docs now say so.
