# r2/ fixture sources (Cloudflare R2 event notifications → Queues)

Fetched 2026-10-08. The primary source is https://developers.cloudflare.com/r2/buckets/event-notifications/ ("Message format"). The doc source is https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/r2/buckets/event-notifications.mdx, and the live `index.md` was checked and matches. JSON files were re-serialized with 2-space indentation.

The docs contain **one** example message body, for `CopyObject`. The other three bodies are derived from it using the documented property table. These are edits, not captures.

| Fixture | Source | Edits |
| --- | --- | --- |
| `queue-copy.json` | "Message format" example | None. `action` is `"CopyObject"` and `copySource` is `{ bucket, object }`. |
| `queue-put.json` | Derived from `queue-copy.json` | `action` set to `"PutObject"`. `copySource` removed (the table says "only present for events triggered by `CopyObject`"). |
| `queue-delete.json` | Derived | `action` set to `"DeleteObject"`. `object.size` and `object.eTag` removed (the table says "not present for object-delete events"). `copySource` removed. |
| `queue-lifecycle-delete.json` | Derived | Same as `queue-delete.json`, with `action` set to `"LifecycleDeletion"`. |
| `pull-response.json` | HTTP pull consumer response, https://developers.cloudflare.com/queues/configuration/pull-consumers/ ("3. Pull messages") | None. Verbatim doc example. **Its messages are not R2 notifications**: the bodies are `"hello"` and `"world"`. |

## Documented `action` values

- Event-type table: `object-create` is triggered by `PutObject`, `CopyObject` and `CompleteMultipartUpload`. `object-delete` is triggered by `DeleteObject` and `LifecycleDeletion`.
- Property table: "`action` … Example actions include: `PutObject`, `CopyObject`, `CompleteMultipartUpload`, `DeleteObject`."

So the full documented set is `PutObject`, `CopyObject`, `CompleteMultipartUpload`, `DeleteObject` and `LifecycleDeletion`. The Cloudflare Go SDK rule enum (`r2/bucketeventnotification.go` in cloudflare-go) lists the same five for rule configuration.

## Property types (doc table)

`account` String, `action` String, `bucket` String, `object.key` String, `object.size` Number, `object.eTag` String, `eventTime` String, `copySource.bucket` String, `copySource.object` String. Object key encoding is **not documented**.

## Envelope and pull consumer

- Worker consumer: the body above is `message.body`. The `Message` interface (https://developers.cloudflare.com/queues/configuration/javascript-apis/#message) has `readonly id: string; readonly timestamp: Date; readonly body: Body; readonly attempts: number;`, and `MessageBatch` has `queue` and `messages`.
- HTTP pull: each message has `body`, `id`, `timestamp_ms`, `attempts`, `metadata` and `lease_id`. **`body` is a string.** The API type in the official TS SDK is `body?: string` (https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/queues/messages.ts, `MessagePullResponse.Message`). The prose says "`body` - this may be base64 encoded based on the content-type the message was published as" and "For both the `json` and `bytes` content types, this means that they will be base64-encoded … The `text` type will be sent as a plain UTF-8 encoded string." **Contradiction:** the doc example shows `"body": "hello"` (not base64) with `"metadata": { "CF-Content-Type": "json" }`. The content type R2 uses when it publishes notifications is not documented. A pull parser should accept a base64-encoded JSON string, a plain JSON string, or an already-parsed object.
- `id` (pull): "a unique, read-only ephemeral identifier for the message."
