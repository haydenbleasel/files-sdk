# s3-compatible/ fixture sources

Fetched 2026-10-08 by an audit of every S3-compatible adapter's notification support. Only RustFS, Wasabi and Storj document S3 `Records[]`-shaped notifications with an example. The other wrappers have none, or use their own format (Oracle, IBM COS, Alibaba, Tencent, Yandex), or don't document the payload (IDrive e2).

| Fixture | Source | Edits |
| --- | --- | --- |
| `rustfs-webhook.json` | The example envelope on https://docs.rustfs.com/en/operations/event-notifications ("S3-compatible JSON envelope … Decode the object key as URL-encoded data before using it"). | None. The doc's example shows only this subset of fields. There's no `eventSource` on the record, and the key encodes `/` as `%2F`. |
| `wasabi-sns-message.json` | The example notification on https://docs.wasabi.com/docs/event-notifications-bucket. It is a **screenshot** (https://cdn.document360.io/bef0a1ea-7768-4d5a-b520-c4fe2f7fafad/Images/Documentation/image-32MVLHKY.png), transcribed by hand. | **Transcribed.** `eTag`, `ownerIdentity`, `userIdentity`, request elements and the optional `enhancedParameters` object were left out. Wasabi delivers this as the `Message` of an AWS SNS notification. |
| `storj-event.json` | The example event on https://storj.dev/dcs/buckets/bucket-eventing (fetched 2026-10-08; the page's Markdown source is `app/(docs)/dcs/buckets/bucket-eventing/page.md` in github.com/storj/docs). | None. |
| `storj-test-event.json` | The test event on the same page. | None. |

Storj delivers only to a Google Pub/Sub topic. The S3 event is the message's `data`, base64-encoded, with no message attributes: the publisher sends `&pubsub.Message{Data: data}` (`satellite/eventing/pubsub.go` in github.com/storj/storj). Keys are encoded per path segment with Go's `url.QueryEscape`, keeping `/`: `my file+test (1).txt` becomes `my+file%2Btest+%281%29.txt` (`EncodeForS3Event` and its test vectors in `satellite/eventing/notification.go` / `notification_test.go`). That is the same rule as AWS, so the `s3` decoder applies. The Pub/Sub envelopes in the tests are built around `storj-event.json`, in the push and pull shapes from `../gcs/`.
