---
"files-sdk": patch
---

`complete` on the `files-sdk/api` gateway no longer fails just because the upload token expired while the bytes were still landing. The token bounds when an upload may start; a large body can finish after the window closes, and the client only completes once it has. `complete` now redeems a token for a grace period after it expires (default one hour, set with the new `completeGracePeriod` option, in seconds), and a `completions` store remembers the result for that long too. The proxy `PUT` itself is still held to the token's expiry. Proxy upload tokens are also no longer clamped to the adapter's `signedUpload.maxExpiresIn`: that limit applies to storage-signed targets, while the proxy is the gateway's own and only `authorize`'s `maxExpiresIn` caps it.
