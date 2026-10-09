---
"files-sdk": patch
---

Plugin fixes:

- `files-sdk/tiering` and `files-sdk/failover` advertise only what every backend supports, so an unsupported option fails up front instead of only on some keys or after a failover. Tiering also reports `serverSideCopy: false`, and `events: false` with `fallback: true`.
- `files-sdk/signed-url-policy` narrows `signedUpload`, `publicUrl`, and `signedUrl` to what still works under the policy.
- `files-sdk/cache` invalidates a key on storage events.
- `files-sdk/compression` reports an unknown stored algorithm as `Unsupported`.
- `files-sdk/dedup` keeps `size` and `etag` on events for objects it didn't write.
