# s3-compatible/ fixture sources

Fetched 2026-10-08 by an audit of every S3-compatible adapter's notification support. Only RustFS, Wasabi and Storj document S3 `Records[]`-shaped notifications with an example. The other wrappers have none, or use their own format (Oracle, IBM COS, Alibaba, Tencent, Yandex), or don't document the payload (IDrive e2).

| Fixture | Source | Edits |
| --- | --- | --- |
| `rustfs-webhook.json` | The example envelope on https://docs.rustfs.com/en/operations/event-notifications ("S3-compatible JSON envelope … Decode the object key as URL-encoded data before using it"). | None. The doc's example shows only this subset of fields. There's no `eventSource` on the record, and the key encodes `/` as `%2F`. |
| `wasabi-sns-message.json` | The example notification on https://docs.wasabi.com/docs/event-notifications-bucket. It is a **screenshot** (https://cdn.document360.io/bef0a1ea-7768-4d5a-b520-c4fe2f7fafad/Images/Documentation/image-32MVLHKY.png), transcribed by hand. | **Transcribed.** `eTag`, `ownerIdentity`, `userIdentity`, request elements and the optional `enhancedParameters` object were left out. Wasabi delivers this as the `Message` of an AWS SNS notification. |

Storj (https://storj.dev/dcs/buckets/bucket-eventing) sends S3 `Records[]` too, but only through Google Pub/Sub, so the message arrives base64-encoded in a Pub/Sub envelope. The `s3` parser doesn't unwrap Pub/Sub, so the `storj` adapter claims no format yet.
