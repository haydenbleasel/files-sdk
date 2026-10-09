# Parser brief: storage notification formats

Facts for the `files-sdk/events` parsers, sourced from each folder's `SOURCES.md` (full URLs and quotes are there). **⚠** marks spots where the docs are silent, ambiguous or contradict themselves.

Target shape: `FileEvent { type: "created" | "deleted", key, size?, etag?, versionId?, contentType?, time (ms epoch), id, raw }`.

---

## S3 classic (`Records[]`): Lambda, SQS body, SNS `Message`, MinIO

**Detecting the wrapper**

| Delivery | How to recognise it |
| --- | --- |
| Direct Lambda | `{ Records: [{ eventSource: "aws:s3", s3: {...} }] }` |
| SQS | `Records[].eventSource === "aws:sqs"`. `body` is a JSON **string** containing the S3 event (or the test event). |
| SNS in SQS (raw delivery off) | The SQS `body` parses to `{ Type: "Notification", Message: "<json string>" }`, so it is double-encoded. Ignore `Subject`. |
| MinIO | Wraps the S3 shape as `{ EventName, Key, Records: [...] }` and uses `eventSource: "minio:s3"`. |

**Test event.** `{ Service: "Amazon S3", Event: "s3:TestEvent", Time, Bucket, RequestId, HostId }` has no `Records`. Ignore it and do not error. The docs say: "ensure your code can distinguish between and properly handle both message formats."

**Key encoding**

- AWS `s3.object.key` is form-URL-encoded: "red flower.jpg becomes red+flower.jpg". Decode with `decodeURIComponent(key.replace(/\+/g, " "))`, which is AWS's own sample. A literal `+` therefore arrives as `%2B`.
- The Lambda tutorial's sample key is `test%2Fkey`. ⚠ Whether real AWS events encode `/` is not stated. The decoder above handles both.
- MinIO `object.key` is Go `url.QueryEscape` output, so `/` becomes `%2F` and a space becomes `+`. Same decoder.
- MinIO's top-level `Key` is `"<bucket>/<raw key>"`, already unescaped. Strip the `bucket/` prefix if you use it, or just decode `object.key`. See minio/minio#7665 ("working as intended").

**Event names.** AWS `eventName` has **no** `s3:` prefix ("doesn't contain the s3: prefix"). MinIO **keeps** it (`s3:ObjectCreated:Put`). Strip an optional `s3:` before matching.

| Mapping | Event names |
| --- | --- |
| created | `ObjectCreated:Put`, `ObjectCreated:Post`, `ObjectCreated:Copy`, `ObjectCreated:CompleteMultipartUpload` |
| deleted | `ObjectRemoved:Delete`, `ObjectRemoved:DeleteMarkerCreated`, `LifecycleExpiration:Delete`, `LifecycleExpiration:DeleteMarkerCreated`. Lifecycle events are a separate opt-in; `ObjectRemoved:*` "don't alert you for automatic deletes from lifecycle configurations". |
| ignore (AWS) | `ObjectRestore:*`, `ReducedRedundancyLostObject`, `Replication:*`, `LifecycleTransition`, `IntelligentTiering`, `ObjectTagging:*`, `ObjectAcl:Put`, `ObjectAnnotation:*`, `ObjectRetention:Put` |
| ignore (MinIO) | `s3:ObjectCreated:PutTagging`, `DeleteTagging`, `PutRetention`, `PutLegalHold`, `PutEncryption`. MinIO files these metadata operations under ObjectCreated, so a naive `ObjectCreated:*` match emits false "created" events. Also ignore `s3:ObjectAccessed:*`, `s3:ObjectRestore:*`, `s3:ObjectTransition:*`, `s3:Scanner:*` and `s3:Replication:*`. |

⚠ MinIO names with no clear mapping:

- `s3:ObjectRemoved:NoOP`: the name suggests a delete that removed nothing. MinIO's own code treats it as a removed event (no size/etag).
- `s3:ObjectRemoved:DeleteAllVersions`: probably maps to deleted.
- `s3:LifecycleDelMarkerExpiration:Delete`: a delete marker expired, not an object. Probably ignore.

**Dedupe and ordering.** There is no event id in `Records[]`. `sequencer` is "A string representation of a hexadecimal value … only used with PUT and DELETE requests". To order two events: "left-pad the shorter value with zeros, and then do a lexicographical comparison". Sequencers are only comparable per key. Suggested id: `` `${bucket}/${key}#${sequencer}` ``, falling back to `responseElements["x-amz-request-id"]` when `sequencer` is missing. MinIO's `sequencer` is the object ModTime in hex nanoseconds (`fmt.Sprintf("%X", ModTime.UnixNano())`). ⚠ S3 retries "might cause duplicate S3 Event Notifications".

**Time.** `eventTime` is ISO-8601 with milliseconds (`"1970-01-01T00:00:00.000Z"`). MinIO uses `"2006-01-02T15:04:05.000Z"`, but older MinIO README samples show no millis.

**Size and etag**

- `size` is a number (the doc schema says "The object size in bytes (as a number)"). `eTag` is unquoted hex. Multipart uploads have a `-N` suffix (the MinIO example shows `430f…2d08-1`).
- Delete records have **no** `size`/`eTag` (Powertools/SAM fixtures; MinIO `ToEvent`). `versionId` is present only on versioned buckets.
- ⚠ MinIO marks `size` as `omitempty`, so a **0-byte object's create event has no `size`**. `contentType` (and `userMetadata`) exist on MinIO events only, not AWS.

**Versions.** `eventVersion` is `"2.6"` in the current docs, while the Lambda samples show `2.0`/`2.1`. AWS advises an equality check on the major version and ignoring unknown fields.

## S3 → EventBridge

Recognise it by `source: "aws.s3"` and `detail-type`.

- created: `"Object Created"`. `detail.reason` is `PutObject`, `POST Object`, `CopyObject` or `CompleteMultipartUpload`.
- deleted: `"Object Deleted"`. `detail.reason` is `DeleteObject` or `Lifecycle Expiration`. `detail.deletion-type` is `Permanently Deleted` or `Delete Marker Created`.
- ignore all other detail-types (Restore, Storage Class/Access Tier changed, Tags, ACL, Annotation, Retention).

**Key** is `detail.object.key` and is **not URL-encoded**. This is verified in aws-samples PR #43 using `plus+test (2).jpg`; ⚠ the S3 user guide itself does not say. Do **not** reuse the classic decoder.

**Id and time**

- `id` is "A UUID generated for every event". `detail.sequencer` is present on created/deleted.
- `time` is second-precision ISO (`"2021-11-12T00:00:00Z"`).

**Fields.** `detail.object.size` is a number, `etag` is unquoted, and `version-id` is kebab-case.

⚠ Deletes: the doc note says "Some object attributes (such as etag and size) are present only when a delete marker is created". Yet both delete examples are delete markers and show `etag` but **no** `size`. Treat both as optional.

## Cloudflare R2 (Queues)

**Body.** `{ account, action, bucket, object: { key, size?, eTag? }, eventTime, copySource? }`. In a Worker this is `message.body`, an object.

**Pull consumers.** `messages[].body` is a **string**. The docs say `json` content is base64-encoded, but their own example shows a plain `"hello"` with `CF-Content-Type: json` ⚠. Try, in order: an object, then `JSON.parse`, then base64 → `JSON.parse`.

| Mapping | `action` values                                      |
| ------- | ---------------------------------------------------- |
| created | `PutObject`, `CopyObject`, `CompleteMultipartUpload` |
| deleted | `DeleteObject`, `LifecycleDeletion`                  |

**Fields**

- `object.size` is a Number and `object.eTag` an unquoted String. Both are "not present for object-delete events". There is no versionId and no contentType.
- `eventTime` is ISO with milliseconds.
- ⚠ Key encoding is not documented.

**Dedupe.** The body has no event id and no sequencer. The Queue `message.id` (Worker) or `id` (pull) is "a unique, read-only ephemeral identifier for the message". ⚠ It is per-message, and whether a redelivery keeps the same id is not stated. Consider a synthetic id from `bucket + key + action + eventTime (+ eTag)`.

**Verification.** None at the payload level. Trust comes from the Worker binding or the pull API token.

## GCS → Pub/Sub (`payloadFormat: JSON_API_V1`)

**Attributes** (all strings): `notificationConfig`, `eventType`, `payloadFormat`, `bucketId`, `objectId`, `objectGeneration`, `eventTime`, plus optional `overwrittenByGeneration`/`overwroteGeneration` and up to 10 custom attributes.

**Data** is base64 of the object resource JSON. It is absent or empty when `payloadFormat: NONE`, so build the event from attributes alone.

**Key.** `attributes.objectId` (or payload `name`) is the raw object name and is not encoded. `mediaLink` is percent-encoded (`folder%2FTest.cs`). Never derive the key from a link.

| Mapping | Event types |
| --- | --- |
| created | `OBJECT_FINALIZE`. Includes copy, rewrite and restore; on replacement it carries `overwroteGeneration`. |
| deleted | `OBJECT_DELETE` ("permanently deleted"). In versioned buckets also `OBJECT_ARCHIVE` (live version became noncurrent). |
| ignore | `OBJECT_DELETE`/`OBJECT_ARCHIVE` that carry `overwrittenByGeneration`. That is a replacement, and a FINALIZE for the new generation arrives separately. Also ignore `OBJECT_METADATA_UPDATE` and `OBJECT_INITIALIZE` (zonal buckets). |

⚠ In a versioned bucket, `OBJECT_DELETE` also fires when a **noncurrent** generation is purged, while the live key still exists. The payload can't distinguish this, because it always has `timeDeleted`. Expose the `versionId` (generation) and let callers decide.

**Dedupe.** The docs say "you could receive multiple messages, with multiple IDs, that represent the same Cloud Storage event", so `messageId` is **not** a safe dedupe id. Use `bucketId/objectId#objectGeneration:eventType`, adding `metageneration` for metadata updates.

**Time**

- `attributes.eventTime` is RFC 3339 with variable fraction length. The doc example is `"2021-01-15T01:30:15.01Z"`, with two fractional digits.
- `publishTime` is also present. The payload has `timeCreated`, `updated` and `timeDeleted`.

**Fields**

- `size`, `generation` and `metageneration` are **strings** in the JSON API (`"352"`). ⚠ The official "complex" example uses numbers, so accept both.
- `etag` is a GCS token (`"CNHZkbuF/ugCEAE="`), not an MD5. `md5Hash` and `crc32c` are base64.
- Use `generation` as `versionId`, and the payload `contentType`.

**Push wrapper.** `{ message: { attributes, data, messageId, message_id, publishTime, publish_time }, subscription, deliveryAttempt? }`. Ack with 102/200/201/202/204.

**Push verification**

- The `Authorization: Bearer <JWT>` header carries an RS256 OIDC token. Verify it against `https://www.googleapis.com/oauth2/v3/certs` (`jwks_uri` from `https://accounts.google.com/.well-known/openid-configuration`).
- `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}.
- `aud` must equal the configured audience, which defaults to the push endpoint URL: "if not specified, the Push endpoint URL will be used".
- `email` must equal the push service account, and `email_verified === true`.
- "Tokens … may be up to an hour old", so allow for clock skew and `exp`.
- Auth is optional per subscription. Fail closed when it is configured.

## GCS → Eventarc (CloudEvents binary mode)

**Headers.** `ce-id`, `ce-source` (`//storage.googleapis.com/projects/_/buckets/<bucket>`), `ce-specversion: 1.0`, `ce-type`, `ce-subject` (`objects/<name>`, raw) and `ce-time` (RFC 3339). The body is StorageObjectData, the same object resource as above. A structured-mode JSON with the same attributes also exists (Workflows destinations; `eventarc-cloudevent-finalize-structured.json`).

| Mapping | `ce-type` |
| --- | --- |
| created | `google.cloud.storage.object.v1.finalized` |
| deleted | `google.cloud.storage.object.v1.deleted` (and `.archived`, with the same caveats as Pub/Sub) |
| ignore | `.metadataUpdated` |

⚠ The Cloud Run trigger doc says `.deleted` "Occurs when an object is soft deleted", while the GCS Pub/Sub doc says OBJECT_DELETE is "permanently deleted".

**Key.** Take it from `ce-subject` minus the `objects/` prefix, or from body `name`.

**Id.** `ce-id` is described as "Unique identifier for the event". Eventarc is built on Pub/Sub notifications, so the same duplicate caveat applies. Prefer the generation-based id.

**Auth.** ⚠ Not researched. The Eventarc docs fetched here describe no in-request verification for the receiver. The trigger setup grants `roles/eventarc.eventReceiver` to a service account and deploys the target Cloud Run service. The fixtures carry no `Authorization` header.

## Azure Blob Storage → Event Grid

**Detecting the schema**

- Event Grid schema is an array of `{ topic, subject, eventType, eventTime, id, data, dataVersion, metadataVersion }`.
- CloudEvents schema uses `{ source, subject, type, time, id, data, specversion }`, sent as an array **or** a single object ⚠ (docs show both).
- Header `aeg-event-type` is one of `SubscriptionValidation`, `Notification` or `SubscriptionDeletion`.
- Content-Type is `application/json; charset=utf-8` (EG) or `application/cloudevents+json; charset=utf-8` (CE).

**Key.** Parse `subject` as `^/?blobServices/default/containers/([^/]+)/blobs/(.+)$`, allowing an optional leading slash ⚠ (the CE sample omits it).

- ⚠ The docs' BlobCreated example has `subject` container `test-container` but `data.url` container `testcontainer`. Trust `subject`.
- ⚠ Whether blob names are percent-encoded in `subject`/`url` is not documented.
- Key = container + "/" + blob, or the blob alone. That is a design decision for the plugin.

| Mapping | Event types and `data.api` |
| --- | --- |
| created | `Microsoft.Storage.BlobCreated` when `data.api` ∈ {`PutBlob`, `PutBlockList`, `CopyBlob`, `FlushWithClose`}. The overview doc says these "trigger the Microsoft.Storage.BlobCreated event only after data is fully committed". For SFTP also `SftpCommit`. |
| ignore | BlobCreated with `CreateFile` (ADLS; `contentLength: 0` before data is written), `SftpCreate` (empty blob on open) or `SftpWrite` (partial). ⚠ Other APIs (e.g. append/page blob writes) are not listed in the docs. |
| deleted | `Microsoft.Storage.BlobDeleted` (`DeleteBlob`, `DeleteFile`, `SftpRemove`) |
| rename | `Microsoft.Storage.BlobRenamed` (ADLS `RenameFile` / `SftpRename`) has `data.sourceUrl` → `data.destinationUrl`, and `subject` is the destination. Either emit deleted(source) + created(destination), or ignore it. It carries no size or etag. |
| ignore | `Directory*`, `BlobTierChanged`, `AsyncOperationInitiated` (a later BlobCreated follows), `BlobInventoryPolicyCompleted`, `LifecyclePolicyCompleted` |

The docs advise to "check that the eventType is one you are prepared to process".

**Dedupe and ordering.** `id` is "Unique identifier for the event". `data.sequencer` is "An opaque string … logical sequence of events for any particular blob name … standard string comparison". Delivery is at-least-once ("duplicate messages may occur"). ⚠ The doc examples reuse the same `id` across different events. Don't assert cross-fixture uniqueness.

**Time.** `eventTime`/`time` carry **7 fractional digits** (`"2017-06-26T18:41:00.9584103Z"`). Truncate to milliseconds before parsing; don't rely on `Date.parse` accepting 7 digits. ⚠ `LifecyclePolicyCompleted` shows a timestamp with **no timezone** (`"2022-05-26T00:00:40.1880331"`), though that event is ignored anyway.

**Fields**

- `data.contentLength` is an integer. `data.eTag` is unquoted `"0x8D4BCC2E4835CD0"`; Azure's HTTP `ETag` header form is quoted, so normalise if comparing.
- `data.contentType` is a string and is present even on BlobDeleted. There is no versionId in blob events.
- `storageDiagnostics` should be ignored ("When present, should be ignored by event consumers").
- ⚠ `accessTier` appears in the CE BlobCreated example even though the table says it "Appears only for the event BlobTierChanged".
- ADLS `recursive` is the string `"true"`.

**Handshakes**

- Event Grid schema: a `POST` with header `aeg-event-type: SubscriptionValidation` and body `[ { eventType: "Microsoft.EventGrid.SubscriptionValidationEvent", data: { validationCode, validationUrl } } ]`. Reply `200` with `{ "validationResponse": "<validationCode>" }` within 30 s; `202` is rejected. Alternatively, `GET` the `validationUrl` within 10 minutes.
- CloudEvents schema: an `OPTIONS` request with `WebHook-Request-Origin` (plus optional `WebHook-Request-Callback` and `WebHook-Request-Rate`). Reply with `WebHook-Allowed-Origin: <echo origin or *>` and `WebHook-Allowed-Rate: <* or n>`, which MUST be returned if a rate was requested; also send `Allow: POST`. ⚠ Microsoft does not document the actual origin value Event Grid sends, so echo what you receive. ⚠ Both the Azure doc and CE spec v1.0 misprint the `*` example as `WebHook-Request-Origin: *`.
- Event Grid does not sign deliveries. The validation doc says that to prevent replayed requests "you must secure your webhook with Microsoft Entra authentication". It also suggests checking `aeg-subscription-name`.
