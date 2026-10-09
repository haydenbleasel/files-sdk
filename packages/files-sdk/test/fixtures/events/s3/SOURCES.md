# s3/ fixture sources (AWS S3 + MinIO)

All fixtures were fetched on 2026-10-08. Every JSON file was parsed and re-serialized with 2-space indentation, so whitespace differs from the source. Values and key order are unchanged unless an edit is listed below.

## AWS S3, classic notification format (`Records[]`)

| Fixture | Source | Edits |
| --- | --- | --- |
| `lambda-put.json` | "Example message when an object is created using a PUT request", https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html | None. `eventVersion` is `"2.6"`. |
| `lambda-put-encoded-key.json` | Lambda tutorial test event, https://docs.aws.amazon.com/lambda/latest/dg/with-s3-example.html. This is the only official doc example with an encoded key: `"key": "test%2Fkey"`. | None. `eventVersion` is `"2.0"`. |
| `lambda-put-encoded-key-plus.json` | Copy of `lambda-put.json`. | **Edited.** `Records[0].s3.object.key` changed from `HappyFace.jpg` to `photos/my+summer%282024%29.jpg`, which should decode to `photos/my summer(2024).jpg`. No doc example shows `+` for a space, but the encoding rule is documented (see below). |
| `lambda-delete.json` | AWS Powertools for Lambda (Python) test fixture, https://github.com/aws-powertools/powertools-lambda-python/blob/develop/tests/events/s3EventDeleteObject.json | None. The S3 docs have no `ObjectRemoved:*` example in `Records[]` form. This fixture omits `size`, `eTag` and `versionId`. The official SAM CLI template agrees: https://github.com/aws/aws-sam-cli/blob/develop/samcli/lib/generated_sample_events/events/s3/S3Delete.json has only `key` and `sequencer` in `object`. |
| `sqs-body.json` | AWS Powertools test fixture, https://github.com/aws-powertools/powertools-lambda-python/blob/develop/tests/events/s3SqsEvent.json. It is a real-looking S3 → SQS → Lambda event; `body` is the JSON-stringified S3 event. | None. The envelope shape matches the Lambda SQS docs, https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html. |
| `sns-in-sqs.json` | **Assembled** from three docs: (1) the SQS envelope is `Records[0]` of the Lambda SQS "Example standard queue message event", https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html; (2) `body` is the SNS notification as delivered to a subscribed SQS queue (raw message delivery off), https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html, with the doc's `" : "` formatting and newlines kept; (3) `Message` is `lambda-put.json`, compact-stringified. | **Edited.** SNS `"Message" : "Hello world!"` was replaced with the stringified S3 event. The SQS `messageAttributes` (the doc's `myAttribute` example) was emptied. `md5OfBody` is the doc's original value and no longer matches the body. The SNS `Subject` keeps the doc text (`"Testing publish to subscribed queues"`), so parsers must not rely on `Subject`. |
| `test-event.json` | "Amazon S3 test message", https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html | None. |

## AWS S3 → EventBridge

| Fixture | Source | Edits |
| --- | --- | --- |
| `eventbridge-created.json` | "Object created", https://docs.aws.amazon.com/AmazonS3/latest/userguide/ev-events.html | None |
| `eventbridge-deleted.json` | "Object deleted (using DeleteObject)", same page | None. `deletion-type` is `"Delete Marker Created"`. |
| `eventbridge-deleted-lifecycle.json` | "Object deleted (using lifecycle expiration)", same page | None. `reason` is `"Lifecycle Expiration"` and `source-ip-address` is absent. |

EventBridge key encoding: **not URL-encoded.** The S3 docs say nothing about it either way; every example uses `example-key`. The evidence is aws-samples PR #43 (official AWS samples org, merged 2026-10-02): https://github.com/aws-samples/s3-to-lambda-patterns/pull/43. Its description says "Verified on AWS that keys in these events are **not** URL-encoded (unlike S3 → Lambda notifications)". Commit 6071ada adds "S3 EventBridge events carry object keys as-is … Verified with a 'plus+test (2).jpg' key." This matches the plan's belief. It comes from a verified sample-repo change, not from the S3 user guide.

The S3 event type to EventBridge `detail-type` mapping is at https://docs.aws.amazon.com/AmazonS3/latest/userguide/ev-mapping-troubleshooting.html:

- `Object Created` covers `ObjectCreated:Put|Post|Copy|CompleteMultipartUpload`.
- `Object Deleted` covers `ObjectRemoved:Delete|DeleteMarkerCreated` and `LifecycleExpiration:Delete|DeleteMarkerCreated`.

## Not sourced

- `lambda-delete-marker.json` (`ObjectRemoved:DeleteMarkerCreated` in `Records[]` form) was **not created**. No AWS doc, SAM template or Powertools fixture shows one. The event name is documented at https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html. Tests can derive one from `lambda-delete.json` by changing `eventName`.

## Key encoding, quoted

From https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html:

> "The object key name value is URL encoded. For example, red flower.jpg becomes red+flower.jpg. (Amazon S3 returns "application/x-www-form-urlencoded" as the content type in the response.)"

> "The eventName key value references the list of event notification types but doesn't contain the s3: prefix."

The official Lambda handler (Node, same tutorial page) decodes with `decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '))`. The Python handler uses `urllib.parse.unquote_plus(...)`.

## MinIO

| Fixture | Source | Edits |
| --- | --- | --- |
| `minio-webhook-put.json` | "Example … notification for an s3:ObjectCreated:Put event", MinIO AIStor docs, https://docs.min.io/aistor/administration/bucket-notifications/. The old URL https://min.io/docs/minio/linux/administration/monitoring/bucket-notifications.html redirects there. | None. The top-level `EventName` and `Key` and the `s3:` prefix in `eventName` are all present. The same envelope (`EventName`, `Key`, `Records`) appears in the community README examples (Kafka/NSQ/Redis), https://github.com/minio/minio/blob/master/docs/bucket/notifications/README.md. |
| `minio-webhook-put.headers.json` | **Derived from source code, not docs.** https://github.com/minio/minio/blob/master/internal/event/target/webhook.go (`send()`) | Contains only the two headers MinIO sets. `<auth_token>` is a placeholder. |
| `minio-webhook-put-encoded-key.json` | Copy of `minio-webhook-put.json`. | **Edited** to show MinIO's documented-by-code encoding. `Records[0].s3.object.key` is set to `photos%2Fmy+summer%282024%29.jpg`, which is Go `url.QueryEscape` of `photos/my summer(2024).jpg`. Top-level `Key` is set to `test-bucket/photos/my summer(2024).jpg`, which is the bucket plus the unescaped key. Basis: `cmd/event-notification.go` `ToEvent(escape)` runs `keyName = url.QueryEscape(args.Object.Name)` (https://github.com/minio/minio/blob/master/cmd/event-notification.go), and `webhook.go` runs `url.QueryUnescape(eventData.S3.Object.Key)` then `key := bucket + "/" + objectName`. Issue https://github.com/minio/minio/issues/7665 (closed "working as intended") shows a real payload with `"Key": "mybucket/5cdfb588cea4de1db3034a87/colors.xml"` next to `"key": "5cdfb588cea4de1db3034a87%2Fcolors.xml"`. |
| `minio-webhook-delete.json` | **Derived.** No MinIO doc shows a delete payload. Built from `minio-webhook-put.json`. | **Edited.** `EventName` and `eventName` were set to `s3:ObjectRemoved:Delete`, and `size`, `eTag`, `contentType` and `userMetadata` were removed. Per `ToEvent`: `isRemovedEvent := …ObjectRemovedDelete \|\| …ObjectRemovedDeleteMarkerCreated \|\| …ObjectRemovedNoOP; if !isRemovedEvent { ETag, Size, ContentType, UserMetadata … }`. `versionId` is absent, as in the source example (unversioned). `eventTime`, ids and `sequencer` are unchanged from the put example and are placeholders. |

MinIO webhook auth: the header is `Authorization`. The docs and the code disagree on its format.

- AIStor docs (https://docs.min.io/aistor/reference/aistor-server/settings/notifications/webhook-service/, "Auth token"): "MinIO AIStor creates the request authentication header using the value exactly as specified. Depending on the endpoint, you may need to include additional information. For example, for a Bearer token, prepend Bearer: `export MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_myendpoint="Bearer 1a2b3c4f5e"`". A custom scheme such as `"ServiceXYZ 1a2b3c4f5e"` is also allowed.
- Community MinIO source (`internal/event/target/webhook.go`, master): `tokens := strings.Fields(target.args.AuthToken); switch len(tokens) { case 2: req.Header.Set("Authorization", target.args.AuthToken); case 1: req.Header.Set("Authorization", "Bearer "+target.args.AuthToken) }`. A bare token therefore gets `Bearer ` prepended automatically. `Content-Type: application/json` is always set, and the request is a `POST` to the configured endpoint.
- Community README env/config help: `auth_token (string) opaque string or JWT authorization token`.

The MinIO event type list (AIStor docs page above) also includes `s3:ObjectCreated:PutTagging|DeleteTagging|PutRetention|PutLegalHold|PutEncryption`, `s3:ObjectRemoved:DeleteAllVersions|NoOP` and `s3:LifecycleDelMarkerExpiration:Delete`. See NOTES.md for how to map them.
