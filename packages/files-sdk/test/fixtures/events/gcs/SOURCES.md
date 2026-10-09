# gcs/ fixture sources (Cloud Storage → Pub/Sub, and Eventarc CloudEvents)

Fetched 2026-10-08. JSON files were re-serialized with 2-space indentation.

**Google's docs show no complete GCS Pub/Sub notification message.** They document the attributes in a table and say the payload is the JSON API object resource. Every `pubsub-*` fixture is therefore **assembled**:

- `attributes`: names and formats from the "Attributes" table at https://cloud.google.com/storage/docs/pubsub-notifications. Values are made consistent with the object below. `notificationConfig` follows the doc example format `projects/_/buckets/foo/notificationConfigs/3`.
- `data`: base64 of the object resource JSON (`json.dumps(indent=2)`). The object is the official StorageObjectData "Simple" example linked from the Eventarc docs, https://googleapis.github.io/google-cloudevents/examples/binary/storage/StorageObjectData-simple.json (bucket `sample-bucket`, name `folder/Test.cs`, generation `"1587627537231057"`). Its field set matches the JSON API object resource, https://cloud.google.com/storage/docs/json_api/v1/objects.
- `messageId` and `publishTime`: from the Pub/Sub push example at https://cloud.google.com/pubsub/docs/push (`"2070443601311540"`, `"2021-02-26T19:13:55.749Z"`). The last digit of `messageId` is incremented per fixture so fixtures stay distinct; these are placeholders. Because of this assembly, `publishTime` does not line up with `eventTime`.
- The message shape (`data`, `attributes`, `messageId`, `publishTime`, `orderingKey`) is the `PubsubMessage` REST resource, https://cloud.google.com/pubsub/docs/reference/rest/v1/PubsubMessage. A REST pull returns `{ "receivedMessages": [{ "ackId", "message": PubsubMessage, "deliveryAttempt" }] }` (https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/pull). The fixtures are the inner `PubsubMessage`.

| Fixture | Edits beyond the assembly above |
| --- | --- |
| `pubsub-pull-finalize.json` | `eventType: OBJECT_FINALIZE`. `eventTime` is the object's `updated`. |
| `pubsub-pull-delete.json` | `eventType: OBJECT_DELETE`. The payload adds `timeDeleted` (value taken from the official "Complex" example, https://googleapis.github.io/google-cloudevents/examples/binary/storage/StorageObjectData-complex.json), per the doc: "For OBJECT_DELETE notifications, the metadata contained in the payload represents the object metadata as it was before the delete, along with an additional timeDeleted property." `eventTime` equals `timeDeleted`. |
| `pubsub-pull-archive.json` | `eventType: OBJECT_ARCHIVE`, with the same payload as delete. The JSON API defines `timeDeleted` as "Returned if and only if this version of the object is no longer a live version, but remains in the bucket as a noncurrent version". |
| `pubsub-pull-delete-overwritten.json` | `OBJECT_DELETE` plus attribute `overwrittenByGeneration: "1587627537231058"`. **The value is a placeholder** (the doc example value is `107458`). It covers the "Replacing objects" case: "OBJECT_ARCHIVE or OBJECT_DELETE event contains an additional attribute overwrittenByGeneration". |
| `pubsub-pull-metadata-update.json` | `eventType: OBJECT_METADATA_UPDATE`. Payload `metageneration` changed to `"2"` and `contentType` to `"video/mp4"`, following the doc's example of a metadata change. `updated` was not changed. |
| `pubsub-push-finalize.json` | The push wrapper from "Example of a request with the minimum values" (https://cloud.google.com/pubsub/docs/push): `{ message: { data, messageId, message_id, publishTime, publish_time }, subscription }`, plus `attributes`, which GCS notifications always carry. `deliveryAttempt` and `orderingKey` (shown only in the "maximum values" example) are omitted. Note the duplicated camelCase and snake_case keys. |
| `pubsub-push-finalize.headers.json` | `Authorization` is the doc's example token from https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions ("JWT format"), with line wraps removed. It decodes to header `{"alg":"RS256","kid":"7d680d8c70d44e947133cbd499ebc1a61c3d5abc","typ":"JWT"}` and claims `{"aud":"https://example.com","azp":"113774264463038321964","email":"gae-gcp@appspot.gserviceaccount.com","sub":"113774264463038321964","email_verified":true,"exp":1550185935,"iat":1550182335,"iss":"https://accounts.google.com"}`, which matches the doc. The signature will not verify against current Google keys. The docs do not list the push `Content-Type`, so it is omitted. |

## Eventarc (CloudEvents, binary content mode)

| Fixture | Source | Edits |
| --- | --- | --- |
| `eventarc-cloudevent-finalize-structured.json` | Official Functions Framework conformance input, https://github.com/GoogleCloudPlatform/functions-framework-conformance/blob/main/events/generate/data/storage-cloudevent-input.json (structured mode: attributes and `data` in one JSON) | None. The same shape, with placeholders, is in the Eventarc JSON format docs, https://docs.cloud.google.com/eventarc/docs/cloudevents-json: `"source": "//storage.googleapis.com/projects/_/buckets/BUCKET_NAME"`, `"type": "google.cloud.storage.object.v1.finalized"`, `"subject": "objects/my-file.txt"`. |
| `eventarc-cloudevent-finalize.json` | The `data` member of the conformance input above (StorageObjectData). This is the HTTP body in binary mode. | None |
| `eventarc-cloudevent-finalize.headers.json` | The `ce-*` headers are the conformance input's attributes mapped to binary-mode headers. Header names and set match the Cloud Functions local-call doc's storage example (https://docs.cloud.google.com/functions/1stgendocs/running/calling): `Content-Type: application/json`, `ce-id`, `ce-specversion: 1.0`, `ce-time`, `ce-type: google.cloud.storage.object.v1.finalized`, `ce-source: //storage.googleapis.com/projects/_/buckets/MY-BUCKET-NAME`, `ce-subject: objects/MY_FILE.txt`. | Values come from the conformance file rather than the doc's `MY_*` placeholders, so headers and body agree. |
| `eventarc-cloudevent-deleted.json` (+ `.headers.json`) | **Derived** from the finalize pair | Body gains `timeDeleted` (set to `ce-time`). `ce-type` set to `google.cloud.storage.object.v1.deleted`. `ce-id` set to the placeholder `aaaaaa-1111-bbbb-2222-dddddddddddd`. No doc shows a deleted event. |

The CloudEvent header table at https://cloud.google.com/eventarc/docs/cloudevents ("HTTP request headers"):

| Header           | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `ce-id`          | "Unique identifier for the event"                      |
| `ce-source`      | "Identifies the source of the event"                   |
| `ce-specversion` | `1.0`                                                  |
| `ce-type`        | "The type of event data"                               |
| `ce-time`        | "Event generation time, in RFC 3339 format (optional)" |

`ce-subject` (`objects/<name>`) is not in that table but appears in the storage examples above. The storage `events.proto` also declares a CloudEvent extension attribute `bucket` ("The bucket name being watched."), which would arrive as a `ce-bucket` header in binary mode: https://github.com/googleapis/google-cloudevents/blob/main/proto/google/events/cloud/storage/v1/events.proto. No doc example shows `ce-bucket`, so the fixtures omit it. Event types: `google.cloud.storage.object.v1.finalized`, `.archived`, `.deleted` and `.metadataUpdated`.

## `size` and other int64 fields: string vs number

- JSON API object resource (https://cloud.google.com/storage/docs/json_api/v1/objects) lists `"generation": "long"`, `"metageneration": "long"` and `"size": "unsigned long"`, all quoted, so they are strings.
- `StorageObjectData-simple.json` and the conformance fixture use `"size": "352"`, `"generation": "1587627537231057"` and `"metageneration": "1"`, all strings.
- **Contradiction:** the official `StorageObjectData-complex.json` uses numbers (`"size": 0`, `"generation": 96883251`, `"metageneration": 1`). `data.proto` declares them `int64`, and proto3 JSON allows either form. Parse both.
- Pub/Sub `attributes` values are always strings, so `objectGeneration` is a string.

## Push authentication (quoted)

From https://cloud.google.com/pubsub/docs/push: "If a push subscription uses authentication, the Pub/Sub service signs a JWT and sends the JWT in the authorization header of the push request."

From https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions:

- "The JWT is an OpenIDConnect JWT that consists of a header, claim set, and signature." The example shows `"Authorization" : "Bearer eyJhbGciOiJSUzI1NiIs…"`, decoded header `{"alg":"RS256",…}` and claim `"iss":"https://accounts.google.com"`.
- "The tokens attached to requests sent to push endpoints may be up to an hour old."
- "Validating tokens sent by Pub/Sub to the push endpoint involves: Checking the token integrity by using signature validation. Ensuring that the email and audience claims in the token match the values set in the push subscription configuration."
- Go sample: `if payload.Issuer != "accounts.google.com" && payload.Issuer != "https://accounts.google.com" { … "Wrong Issuer" … }`. It also says to "Ensure that `payload.Claims["email"]` is equal to the expected service account set up in the push subscription settings" and "Ensure that `payload.Claims["email_verified"]` is set to true."

Default audience, from the PushConfig `OidcToken.audience` reference (https://cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions): "Audience to be used when generating OIDC token … Note: if not specified, the Push endpoint URL will be used."

JWKS: Google's OIDC discovery document (https://accounts.google.com/.well-known/openid-configuration) has `"issuer": "https://accounts.google.com"` and `"jwks_uri": "https://www.googleapis.com/oauth2/v3/certs"`. The Pub/Sub page does not name the JWKS URL directly; its samples use Google client libraries (`idtoken.NewValidator`, `verify_oauth2_token`, …), which fetch Google's certs.

Unwrapped push (`NoWrapper`, same reference): "Sets the data field as the HTTP body for delivery." With `writeMetadata: true`, it "writes the Pub/Sub message metadata to x-goog-pubsub-<KEY>:<VAL> headers of the HTTP request. Writes the Pub/Sub message attributes to <KEY>:<VAL> headers of the HTTP request." This mode is not covered by fixtures.
