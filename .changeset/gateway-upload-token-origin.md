---
"files-sdk": patch
---

Upload tokens from the `files-sdk/api` gateway are now bound to the origin (scheme and host) of the request that minted them, as well as its path and query. With a `files` factory that picks the instance from the host, a token minted on one tenant's host could previously be redeemed by the proxy upload `PUT` on another's; that request, and `complete` on the wrong host, now get `Unauthorized`. The docs now also warn that a factory must select the instance from the URL, not from a cookie or header, because the proxy `PUT` runs no `authorize`.
