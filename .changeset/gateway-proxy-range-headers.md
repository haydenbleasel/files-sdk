---
"files-sdk": patch
---

Proxied downloads from the `files-sdk/api` gateway play media and send proper validators. With the default `onUnsupportedRange: "reject"`, a `Range: bytes=0-` request to an adapter that can't serve ranges got a `416`, which broke every `<video>` and `<audio>` element (browsers open media with that range). The whole body satisfies it, so it now gets the full object with a `200`; any other range on such an adapter is still a `416`. The `ETag` header is now always a quoted entity-tag, even when the adapter reports it bare as the S3 family does, and `If-Range` matches either form. Proxied responses also send `Last-Modified` when the adapter knows it. `files-sdk/client` keeps reporting the adapter's own etag on proxied downloads, as `head()` does.
