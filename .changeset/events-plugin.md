---
"files-sdk": minor
---

Add `files-sdk/events`, a plugin that turns each provider's bucket notifications into one event shape. Install `events()` with `createFiles` and `files.events` gains:

- `on(type, glob?, handler)` for `created` / `deleted` events, matched against the caller-facing key.
- `dispatch(delivery)` and `parse(delivery)` for queue consumers. They accept an SQS or Lambda event, an R2 Queue message, a Pub/Sub message, an EventBridge event, or an array of them.
- `webhook({ verify })`, an endpoint with the gateway's `{ handle }` shape for providers that push over HTTP. It answers the Event Grid and CloudEvents handshakes and authenticates every delivery: with a shared token, or with Google-signed OIDC tokens for Pub/Sub push.

It reads S3 (SQS, Lambda, SNS → SQS, EventBridge), MinIO and RustFS webhooks, Wasabi (through SNS), R2 Queues, GCS Pub/Sub and Eventarc, and Azure Event Grid in either schema. Adapters declare the format their provider sends as a new `capabilities.events`, which `files.capabilities.events` reports: `s3()` and `s3Fetch()` declare `"s3"` only against AWS, since an S3-compatible endpoint may not send S3's shape, while `minio`, `rustfs`, `wasabi`, `r2`, `gcs`, `firebase-storage` and `azure` declare theirs. Parsing on an adapter with no format throws `Unsupported` instead of guessing, and a malformed delivery throws `Invalid`.

Delivery is at least once and out of order on every provider, so each event carries an `id` to dedupe on, and an optional `dedupe` store drops repeats. Events outside the instance `prefix` (or another `bucket`) are dropped. Gateway uploads reach the same handlers, and `events({ sdk: true })` adds writes made through the instance. The memory adapter emits events natively, with `settled()` for tests.

Plugins gain an optional `event` hook for mapping provider events. `dedup()`, `encryption()`, `compression()`, `versioning()`, `softDelete()` and `tiering()` use it, so their internal keys and stored sizes don't leak into events. The `files` CLI gains `files events parse [file] --format <format>` for debugging a payload.
