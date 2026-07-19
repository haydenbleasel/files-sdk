---
"files-sdk": patch
---

The `fetch` S3 client (`r2({ client: "fetch" })` and hybrid binding signing) now fails closed on keys containing `.` or `..` path segments. WHATWG `URL` — used by both the SigV4 signer and `fetch` itself — collapses dot segments (even percent-encoded ones) before signing, so such keys were silently signed and sent for a _different_, normalized key, and under path-style addressing a `..` segment could escape the bucket entirely. These keys now throw a permanent `Provider` error with guidance to use the `aws-sdk` client, which addresses them literally.
