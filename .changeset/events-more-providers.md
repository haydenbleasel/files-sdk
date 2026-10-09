---
"files-sdk": minor
---

`files-sdk/events` now reads notifications from Backblaze B2, Tigris, Supabase (a Database Webhook on `storage.objects`), Cloudinary, Appwrite and Box, from S3 delivered by SNS over HTTPS, and from Storj, which publishes S3-format events to Google Pub/Sub. The `s3` format unwraps a Pub/Sub message, whether pushed, pulled, or handed over by the Node client library. The matching adapters pick their format automatically. `webhook()` verifies each provider's own signature with `verify: { secret }`:

- B2: HMAC-SHA256.
- Cloudinary: SHA-1 or SHA-256, checked for freshness.
- Appwrite: HMAC-SHA1 over the configured URL, so pass `url`.
- Box: primary or secondary key, checked for freshness.

`verify: { sns }` checks SNS message signatures against the certificate at `SigningCertURL`. That URL must be an HTTPS SNS host on the default port, with no credentials, query or fragment. `topicArn` (one ARN or several) is required. SNS signs messages for any topic, including one an attacker owns, so the topic is checked on every message, subscription confirmations included. The signed `Timestamp` must be no older than `maxAge` (default one hour). Both checks run before any certificate is fetched, and only a few signing keys are cached. With `confirm: true` it also confirms new subscriptions to the pinned topic. B2 hide markers, which a delete through `files-sdk/backblaze-b2` produces, count as deletes. Box keys are rebuilt relative to the adapter's `rootFolderId`. Box reports a trashed file at its Trash location, so `FILE.TRASHED` gets a key only for a file that sat directly in the root folder. Cloudinary events for another resource type are dropped.
