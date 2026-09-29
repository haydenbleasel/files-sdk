---
"files-sdk": patch
---

`files-sdk/api` now passes the request's abort signal to every storage call it makes for `url`, the `download` redirect, `signed-upload-url`, `presign`, `complete`, and both upload `PUT`s. Previously only the read, list, delete, copy, and move calls and the proxied download received it, so the rest ran to completion after the client had disconnected, and an explicit-key upload could still store its object.
