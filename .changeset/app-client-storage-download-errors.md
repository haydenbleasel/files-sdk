---
"files-sdk": patch
---

`files-sdk/client` `download()` now reports a failure at the storage host, after the gateway redirected to a signed URL, with the code its HTTP status implies: `404` is `NotFound`, `401` and `403` are `Unauthorized`, and `409` and `412` are `Conflict`. Previously every such failure was a generic `Provider` error ("gateway responded 404"), so downloading a missing key through a signing adapter never surfaced `NotFound`.
