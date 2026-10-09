# Phase 3 parser brief: b2, tigris, supabase, cloudinary, appwrite, box, uploadthing, sns-http

Researched 2026-10-08 from current official docs, official SDK test suites and official sample repos. Each provider folder has a `SOURCES.md` that maps every fixture to its URL and lists every edit. Target shape: `FileEvent { type: "created" | "deleted", key, size?, etag?, versionId?, contentType?, time (ms epoch), id, raw }`.

## Fixture conventions

- `<name>.json` is a body. Whitespace may be reformatted by oxfmt; values are not.
- `<name>.body` is a **byte-exact** body for signature tests (no trailing newline). Read it as text or bytes. It is not `.json` on purpose: oxfmt rewrites `.json` and would break every HMAC.
- `<name>.headers.json` holds lowercase request headers.
- `<name>.signing.json` / `signing.json` holds the secret, URL and timestamp a verifier needs, plus the expected value.
- `*.derived.json` was derived from a documented payload by editing it, not copied. Treat it as a shape guess.
- The root `.gitattributes` has `* text=auto`. `b2/signed-upload.body` contains `\n` newlines, so a CRLF checkout would break its HMAC. Recommended (outside this folder, not done here): add `packages/files-sdk/test/fixtures/events/**/*.body -text` to `.gitattributes`.
- Every signature vector here was re-verified locally on 2026-10-08 (B2, Box, Cloudinary SHA-1 and SHA-256, Appwrite, UploadThing, and all 8 real SNS messages).

## Corrections to the plan's assumptions

| Plan assumption | Finding |
| --- | --- |
| B2 uses an HMAC-SHA256 header | **Correct**, with details. The header is `X-Bz-Event-Notification-Signature: v1=<lowercase hex>`, an HMAC over the raw body. The signing secret is **optional**: "If this attribute is not set, then the webhook will not be signed." The key is the secret's UTF-8 bytes, not base64-decoded. The Java SDK accepts a comma-separated list. Test events may be signed with a dummy key (the docs contradict each other). **New:** a files-sdk delete through the S3-compatible API without a version id creates a **hide marker**, so it arrives as `b2:HideMarkerCreated:Hide`, not `b2:ObjectDeleted:*`. |
| Cloudinary uses X-Cld-Signature + timestamp | **Partly wrong.** The legacy signature is a **plain SHA-1 or SHA-256 hash of `body + timestamp + api_secret`, not an HMAC**. Freshness is a "reasonable" window; the SDK default is 7200 s. **New:** triggers now have `auth_scheme` (`default` / `legacy_hmac` / `eddsa_v2`), and `eddsa_v2` sends only `X-Cld-Signature_v2` (Ed25519), whose verification is undocumented. A trigger can also set `payload_template`, which replaces the body. |
| Appwrite uses an HMAC signature header | **Correct**, with details. `X-Appwrite-Webhook-Signature` = base64(HMAC-SHA1(key, **configured webhook URL + raw body**)). The verifier must know the exact configured URL. There is no timestamp, so there is no replay protection. |
| Box uses primary/secondary HMAC signatures | **Correct.** base64(HMAC-SHA256(key, raw body bytes followed by `BOX-DELIVERY-TIMESTAMP` bytes)); either header may match; reject if older than 10 min. **New:** v2 webhooks **cannot be created on root folder `0`**, which is the Box adapter's default `rootFolderId`. The Box SDK falls back to verifying a `\/`- and `\uXXXX`-escaped form of the body, which suggests Box signs escaped JSON. Verify the raw body; re-serialized JSON will not match. |
| Tigris (unstated) | Its own `{ events: [...] }` shape, not S3 `Records[]`. **No signature**, only an `Authorization` header (`Basic` or `Bearer`). **No event id.** |
| Supabase (unstated) | There is no hosted Storage webhook; use a Database Webhook on `storage.objects`. **No signature.** **Overwrites arrive as UPDATE**, because Storage upserts with `INSERT ... ON CONFLICT DO UPDATE`. There is no event id. |
| UploadThing callback | Verifiable outside the router (HMAC-SHA256 hex, `hmac-sha256=` prefix, API key). But it fires **only for file-route uploads with a registered `callbackUrl`**. **No callback for files-sdk writes, and no delete event exists.** |
| SNS | Real verifiable messages and certs exist in AWS SDK test suites (captured here). **Raw message delivery strips the signature entirely.** The default `Content-Type` is `text/plain`. |

---

## b2 (Backblaze B2 Event Notifications)

**Envelope:** `{ "events": [ ... ] }`, 1 to 50 events per POST (`maxEventsPerBatch`, default 1). Emit one FileEvent per element.

**Event types** (https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide):

| eventType | FileEvent |
| --- | --- |
| `b2:ObjectCreated:Upload`, `:MultipartUpload`, `:Copy`, `:Replica`, `:MultipartReplica` (any `b2:ObjectCreated:*`) | `created` |
| `b2:ObjectDeleted:Delete`, `b2:ObjectDeleted:LifecycleRule` (any `b2:ObjectDeleted:*`) | `deleted` |
| `b2:HideMarkerCreated:Hide`, `b2:HideMarkerCreated:LifecycleRule` (any `b2:HideMarkerCreated:*`) | `deleted`. A hide marker hides the latest version, and this is what a files-sdk delete produces: B2's S3 DeleteObject without a version id "inserts a delete marker" (https://www.backblaze.com/apidocs/s3-delete-object), and `files-sdk/backblaze-b2` wraps `s3()`, which sends no `VersionId`. |
| `b2:TestEvent`, `b2:MultipartUploadCreated:LiveRead`, anything unknown | ignore. "New event types may be added in the future, so ensure that your code can handle the potential addition of new event types." |

**Fields:**

- key = `objectName` (string). The examples show plain keys (`images/raw/smiley.png`). Whether special characters are percent-encoded is undocumented and needs live capture.
- size = `objectSize` (integer or absent). The guide says "The objectSize is non-null on deletes. The objectSize is 0 for hide markers". The Java SDK says it is null for deletes and hide markers. Treat 0 and null as unknown on deletes.
- versionId = `objectVersionId`.
- etag and contentType: not in the payload.
- time = `eventTimestamp`, an integer already in ms ("Base-10 number of milliseconds since midnight, January 1, 1970 UTC").
- id = `eventId`: "The unique identifier of the event. You can use this as a primary key when processing events."
- Also present: `accountId`, `bucketId`, `bucketName`, `matchedRuleName`, `eventVersion` (1).

**Verification** (quotes from the reference guide, "Verifying the Webhook Request Signature"):

1. If no secret is configured, skip (unsigned). If one is configured and `x-bz-event-notification-signature` is missing, fail with 401. "If this attribute is not set, then the webhook will not be signed."
2. Split the header value on `,` and parse each part as `v1=<hex>`. "The signature header value comprises the signature version, always v1, followed by an equals sign =, followed by the lowercase hex-encoded signature value." Reject other versions.
3. Compute `hex(HMAC-SHA256(key = utf8(secret), data = raw body bytes))`. "create an HMAC SHA-256 digest using the hmacSha256SigningSecret from the Event Notification rule as the key, with the request payload as the data. The resulting hex-encoded HMAC digest value must match the signature in the header."
4. Compare in constant time. On mismatch, "respond to the request with a 401 Unauthorized HTTP response and cease processing".

**Handshake:** none. The dashboard "Test Rule" button sends a `b2:TestEvent`, which must get a 2xx; ignore it as an event. Delivery: "at-least-once delivery guarantee". "Backblaze B2 sets a three-second timeout on the webhook request ... Backblaze B2 will retry the request if your endpoint does not return a 200 response within the time limit." Dedupe on `eventId`.

**Verdict: ready to implement.** The payload and algorithm are documented, and there is an SDK-sourced HMAC vector (`signed-upload.*`). Live capture is recommended for the delete and hide-marker shapes and for which key signs test events.

---

## tigris (Tigris Object Notifications)

**Envelope:** `{ "events": [ { eventVersion, eventSource: "tigris", eventName, eventTime, bucket, object: { key, size, eTag } } ] }` (https://www.tigrisdata.com/docs/buckets/object-notifications/).

| eventName | FileEvent |
| --- | --- |
| `OBJECT_CREATED_PUT`, `OBJECT_CREATED_MULTIPART`, `OBJECT_CREATED_COPY` | `created` |
| `OBJECT_DELETED` | `deleted` |
| `OBJECT_TRANSITIONED` (storage-class change) | ignore |
| `OBJECT_RENAME` | ignore for now. There is no documented payload, so the old key is unknown. Needs live capture to map it to deleted(old) + created(new). |
| unknown | ignore |

**Fields:**

- key = `object.key`. Encoding of special characters is undocumented and needs live capture.
- size = `object.size` (number).
- etag = `object.eTag` ("typically an MD5 hash", unquoted in the example).
- time = `Date.parse(eventTime)` (RFC 3339).
- versionId and contentType: none.
- id: **none in the payload.** Synthesize a deterministic id, for example `sha256(bucket + "\n" + eventName + "\n" + key + "\n" + eTag + "\n" + eventTime)`. Deliveries are "at least once", and "notifications can be sent out of order ... The Last-Modified timestamp can be used to determine the order".

**Verification:** there is no signature. Compare `Authorization` in constant time against the configured `Basic base64(user:pass)` or `Bearer <token>`. "For basic authentication, the header will be set as follows: Authorization: Basic <base64 encoded username:password> ... For token authentication ... Authorization: Bearer <token>".

**Handshake:** none. "A 2xx status code acknowledges the request ... Any other status is treated as a failure and retried." There is a 10 s timeout.

**Verdict: ready to implement** for created and deleted. `OBJECT_RENAME` needs live capture.

---

## supabase (Database Webhook on `storage.objects`)

**Envelope** (https://supabase.com/docs/guides/database/webhooks): `{ type: "INSERT"|"UPDATE"|"DELETE", table, schema, record, old_record }`. It is built by `jsonb_build_object('old_record', OLD, 'record', NEW, 'type', TG_OP, 'table', TG_TABLE_NAME, 'schema', TG_TABLE_SCHEMA)`. The row is the full `storage.objects` row.

**Filter:** require `schema === "storage"` and `table === "objects"`, and `(record ?? old_record).bucket_id === <adapter bucket>`. Otherwise ignore.

| type | FileEvent |
| --- | --- |
| `INSERT` | `created` from `record` |
| `DELETE` | `deleted` from `old_record` |
| `UPDATE` where `old_record.name !== record.name` (move) | `deleted(old_record.name)` + `created(record.name)` |
| `UPDATE` where `metadata.eTag` or `version` changed (overwrite) | `created` from `record`. **This is how `upsert: true` overwrites arrive**, because `upsertObject` uses `INSERT ... ON CONFLICT ... DO UPDATE` (supabase/storage `src/storage/database/pg.ts`). Users must subscribe to UPDATE as well as INSERT and DELETE. |
| other `UPDATE` (`last_accessed_at`, `user_metadata`, ...) | ignore |

**Fields** (row shape from the official `storage.objects` example, see `SOURCES.md`):

- key = `name`.
- size = `metadata.size` (number).
- etag = `metadata.eTag`. Strip surrounding quotes (`"\"ca39...\""`), as `files-sdk/supabase` already does (`stripEtag`).
- contentType = `metadata.mimetype`.
- time = `Date.parse(record.updated_at ?? record.created_at)` for created. Deletes carry no deletion time, so use receipt time. Postgres JSON timestamps look like `2024-10-25T15:52:13.993+00:00`.
- versionId: `version` is a Storage-internal per-write uuid, not S3-style versioning. Leave it out of `versionId` (or expose it only via `raw`).
- id: **none.** Synthesize `${type}:${row.id}:${row.version}` (row = `record ?? old_record`).

**Verification:** "Database Webhooks" have **no signature**. The user adds a secret header in the trigger's headers argument; verify it in constant time. The Dashboard auto-adds `Authorization: Bearer <service key>` only for Edge Function targets with `verify_jwt`.

**Handshake:** none. Delivery is one async `pg_net` POST, default 1000 ms timeout, no retry logic in `http_request()`. So loss is possible; recommend reconciliation.

**Verdict: ready to implement** (envelope and filtering). Live capture is recommended to pin the exact `to_jsonb(row)` column set (`path_tokens`, `level`, `archived_at`, `is_delete_marker`, `is_versioned`) and timestamp format. The parser should only rely on `name`, `bucket_id`, `id`, `version`, `metadata.*`, `created_at` and `updated_at`.

---

## cloudinary (webhook notifications)

**Bodies** (https://cloudinary.com/documentation/notifications, "Notification response examples"). The type is in `notification_type`, which equals the trigger `event_type` (https://cloudinary.com/documentation/admin_api, "event_type possible values").

| notification_type | FileEvent |
| --- | --- |
| `upload` | `created`: key `public_id`, size `bytes`, etag `etag`, versionId `version_id`, time `Date.parse(created_at)` |
| `delete` | `deleted`, **one per `resources[]` entry**: key `resources[i].public_id`, versionId none (`version` is the asset's version timestamp), time `notification_context.triggered_at` |
| `rename` | optional: `deleted(from_public_id)` + `created(to_public_id)` with no size or etag; otherwise ignore |
| `delete_by_token` | `deleted` probably, but no payload example exists; needs live capture |
| everything else (`move`, `eager`, `explode`, `multi`, `error`, `moderation`, `resource_*_changed`, `create_folder`, `delete_folder`, `access_control_changed`, `related_assets`, `proof_status_changed`, ...) | ignore |

**Fields:**

- Ignore events whose `resource_type` (and `type`, the delivery type) differ from the adapter's configured `resourceType` / `type`. `files-sdk/cloudinary` keys are `public_id` within one resource type, which defaults to `raw`.
- contentType: for image and video, derive `${resource_type}/${format}` as the adapter does. For raw there is none.
- `notification_context.triggered_at` has microseconds (`2024-06-25T12:24:29.599817Z`). Trim to milliseconds before `Date.parse`.
- id: `request_id` when present (upload, rename). Otherwise synthesize `${notification_type}:${asset_id}:${triggered_at}`.
- `signature_key` in the body names the API key whose secret signed it.

**Verification, legacy `X-Cld-Signature`** (https://cloudinary.com/documentation/notification_signatures):

1. `ts = X-Cld-Timestamp` (unix seconds) and `sig = X-Cld-Signature`.
2. "Create a single string containing the entire response body", then "Append the X-Cld-Timestamp value", then "Append your API secret". Use the raw body string.
3. "Create a hexadecimal message digest (hash value) of the string using an SHA function." Use SHA-1 by default, or SHA-256 if the account uses it ("By default, Cloudinary supports both SHA-1 and SHA-256 digests"). Choose by signature length (40 vs 64 hex characters). This is **not an HMAC.**
4. Compare in constant time. Reject stale timestamps: "within the last 2 hours" (SDK default `valid_for = 7200`).
5. Secret selection: "If you've established a dedicated API key for all your webhook notifications, make sure to employ the associated api_secret for verification. Otherwise, use the oldest active key".
6. If only `X-Cld-Signature_v2` is present (`auth_scheme: eddsa_v2`), fail closed. The Ed25519 verification is undocumented.

**Handshake:** none. Retries: "If the response is not 200 OK, three additional notification attempts are initiated" (after 3, 6 and 9 minutes). There is a 20 s timeout.

**Verdict: ready to implement** for legacy signatures (doc SHA-1 vector and SDK SHA-256 vector included). **`X-Cld-Signature_v2` (EdDSA) needs live capture** plus a published public key. `default` triggers still send the legacy header.

---

## appwrite (project webhooks, storage file events)

**Body:** the File model document (https://appwrite.io/docs/references/cloud/models/file): `$id`, `bucketId`, `$createdAt`, `$updatedAt`, `$permissions`, `name`, `folder`, `key`, `signature` (MD5), `mimeType`, `sizeOriginal`, `sizeActual`, `chunksTotal`, `chunksUploaded`, `encryption`, `compression`. It is PHP `json_encode`d, so `/` is escaped as `\/`.

**Event type:** from the `X-Appwrite-Webhook-Events` header, a comma-separated list of every matching pattern. Pick the fully-qualified one, `buckets.{bucketId}.files.{fileId}.{verb}` with `bucketId === body.bucketId` and `fileId === body.$id`.

| verb | FileEvent |
| --- | --- |
| `create` | `created` |
| `delete` | `deleted`. The body is the deleted file document (e2e `testDeleteBucketFile`). |
| `update` (name or permissions change; contents are immutable) | ignore |
| other resources (`buckets.*.create`, `users.*`, ...) | ignore |

**Fields:**

- Filter `bucketId === <adapter bucket>`.
- key = **`$id`**. `files-sdk/appwrite` uses the key as the `fileId`. Note: `body.key` is Appwrite's virtual path (`folder + name`) and is **not** the files-sdk key.
- size = `sizeOriginal`; contentType = `mimeType`; etag = `signature` (MD5 hex).
- time = `Date.parse($createdAt)` for create. Delete has no deletion time, so use receipt time.
- id = `X-Appwrite-Webhook-Delivery-Id` when present. The worker comment says it "Identifies this event to this webhook; the same on every attempt". It is in `Webhooks.php` on `main` but not yet in the docs header table. Otherwise synthesize `${verb}:${$id}:${$updatedAt}`.

**Verification** (https://appwrite.io/docs/advanced/platform/webhooks, "Verification"):

1. "Concatenate the **webhook URL** and the **request body** (no spaces in between)." Use the URL exactly as configured in Appwrite. The receiver must be given it; do not derive it from the incoming request.
2. "Generate an HMAC-SHA1 hash of the concatenated string using your webhook's **signature key**."
3. "Base64 encode the resulting hash."
4. "Compare the result to the `X-Appwrite-Webhook-Signature` header value." Use a constant-time compare.

There is no timestamp, so replay protection is impossible; dedupe on the delivery id. Optional HTTP Basic auth can also be configured.

**Handshake:** none. 15 s timeout. Failed deliveries are redelivered, and the webhook auto-disables after repeated failures (e2e `testWebhookAutoDisable`).

**Verdict: ready to implement.** The algorithm is documented and asserted in Appwrite's e2e tests. The body is assembled from the documented model because the docs publish no file-event example; live capture is recommended to confirm field order and header order.

---

## box (webhooks v2)

**Body** (https://developer.box.com/guides/webhooks/v2/): `{ type: "webhook_event", id, created_at, trigger, webhook: { id }, created_by, source: <file>, additional_info }`.

| trigger | FileEvent |
| --- | --- |
| `FILE.UPLOADED` ("A file is uploaded or moved to this folder"), `FILE.RESTORED` ("A file is restored from trash") | `created` |
| `FILE.COPIED` | `created` only if `source` is the new copy. That is undocumented, so ignore it until a live capture shows which file `source` describes. |
| `FILE.TRASHED` ("A file is moved to trash") | `deleted`. The adapter deletes with `files.deleteFileById`. Box's DELETE /files/:id either trashes or permanently deletes depending on enterprise settings, so a files-sdk delete produces `FILE.TRASHED` or `FILE.DELETED`. |
| `FILE.DELETED` ("A file is permanently deleted") | `deleted`. It may duplicate an earlier `FILE.TRASHED`, so consumers must be idempotent. |
| `FILE.MOVED`, `FILE.RENAMED` | ignore for now. The payload has only the new location, so the old key cannot be computed. Needs live capture. |
| `NO_ACTIVE_SESSION`, `FILE.PREVIEWED`, `FILE.DOWNLOADED`, `FILE.LOCKED`, `FILE.UNLOCKED`, `COMMENT.*`, `FOLDER.*`, ... | ignore |

**Fields:**

- key: `files-sdk/box` keys are paths under `rootFolderId`. Build the key from `source.path_collection.entries`: take the entries after the one whose `id === rootFolderId`, join their `name`s with `/`, then append `/` + `source.name`. If `rootFolderId` is not in the path, the file is outside the adapter's root, so ignore it.
- size = `source.size`.
- etag = `source.etag` (the Box adapter's `etag`; `source.sha1` is the content SHA-1).
- versionId = `source.file_version.id`; contentType: none.
- time = `Date.parse(created_at)` (RFC 3339 with offset).
- id = body `id`: "When Box retries a webhook this ID will not change, while the ID in the header changes between calls."

**Verification** (https://developer.box.com/guides/webhooks/v2/signatures-v2/):

1. Require `box-signature-version === "1"` and `box-signature-algorithm === "HmacSHA256"` ("Value is always `1`" / "Value is always `HmacSHA256`").
2. Freshness: "Check if the timestamp in the `BOX-DELIVERY-TIMESTAMP` header of the payload is not older than ten minutes." The Box SDK also rejects future timestamps; allow small skew.
3. `digest = base64(HMAC-SHA256(key, rawBodyBytes ‖ timestampHeaderBytes))`: "append the bytes of the payload body first, and then the bytes of the timestamp".
4. Valid if (primary key digest equals `BOX-SIGNATURE-PRIMARY`) or (secondary key digest equals `BOX-SIGNATURE-SECONDARY`), compared in constant time on the decoded bytes. The doc's code samples swap the two headers; follow the prose.
5. Use raw bytes. Box escapes `/` and non-ASCII, so re-serialized JSON will not match. The SDK retries with a re-escaped body as a fallback.

**Handshake:** none. "Box will retry webhook deliveries up to 12 times over a period of 2 hours." A delivery needs a 2xx within 30 s. **V2 webhooks cannot target folder `0`**, so document that `rootFolderId` (or the watched folder) must be a real subfolder.

**Verdict: ready to implement** for `FILE.UPLOADED` and signatures (SDK vectors with known keys included). **`FILE.TRASHED` and `FILE.DELETED` payload shapes need live capture.** They are derived here by only changing `trigger`, and `path_collection` for trashed items is unknown.

---

## uploadthing (upload callback)

**What exists:** the UploadThing API POSTs to the `callbackUrl` registered for a **file-route upload** (`/route-metadata`). Body: `{ status: "uploaded", metadata, origin, file: { name, size, type, customId, key, url, appUrl, ufsUrl, fileHash } }`, with header `uploadthing-hook: callback`. Failures use `uploadthing-hook: error` with `{ fileKey, error }`.

**Mapping, if ever used:**

- `callback` maps to `created`: key = `file.customId ?? file.key` (files-sdk routes by customId), size = `file.size`, contentType = `file.type`, etag = `file.fileHash` (md5 hex).
- time: none in the payload, so use receipt time.
- id: synthesize from `file.key` + `fileHash`.
- `error`: ignore.

**Verification:** `x-uploadthing-signature: hmac-sha256=<hex>`, where hex = HMAC-SHA256(key = API key `sk_...` from `UPLOADTHING_TOKEN`, data = raw body). "The signature is a HMAC SHA256 of the request body signed using your API key" (https://docs.uploadthing.com/uploading-files). Implementation: `verifySignature` in `packages/shared/src/crypto.ts`. It can be verified outside the router; there is no timestamp.

**Verdict: not feasible** as a bucket-notification source:

1. **No delete event exists** in UploadThing.
2. `files-sdk/uploadthing` uploads with `utapi.uploadFiles` and builds ingest URLs without registering route metadata, so **files-sdk writes never trigger a callback**.
3. Callbacks only exist for uploads that go through an UploadThing file router, and they are already handled by `onUploadComplete`.

A created-only `uploadthing` parser is possible (fixtures included), but it would not reflect bucket state.

---

## sns-http (Amazon SNS HTTP/S, for S3 to SNS to HTTPS)

**Message types** (header `x-amz-sns-message-type`, body `Type`):

| Type | Action |
| --- | --- |
| `SubscriptionConfirmation` | Verify the signature **and** the `SubscribeURL` host, then confirm. "you must visit the `SubscribeURL` URL (for example, by sending an HTTP GET request to the URL)", or call `ConfirmSubscription` with `Token`. Emit no events. "Amazon SNS will not send notifications to the endpoint until you confirm the subscription." |
| `Notification` | Verify, then `JSON.parse(Message)` and hand it to the s3 parser (`Records[]` gives created/deleted; `{"Event":"s3:TestEvent"}` is ignored). See `../s3/`. |
| `UnsubscribeConfirmation` | Verify, then ignore (optionally surface it). Never auto-visit its `SubscribeURL`, which would re-subscribe. |

**Ids and time:** envelope `MessageId` stays stable across retries ("For a notification that Amazon SNS resends during a retry, the message ID of the original message is used"). Per-record ids and times come from the S3 record (`eventTime`, `sequencer`). The body's `Content-Type` is `text/plain; charset=UTF-8` by default, so do not require `application/json`.

**Verification** (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html):

1. Require `SignatureVersion` to be `"1"` or `"2"`.
2. Validate `SigningCertURL`: `https:`, path ends in `.pem`, and host matches `^sns\.[a-zA-Z0-9-]{3,}\.amazonaws\.com(\.cn)?$` (the official JS, PHP and Ruby validators). Stricter is better: require host === `sns.<expected-region>.amazonaws.com`, as aws-sdk-java-v2 `sns-message-manager` does. That library also checks the cert CN (`sns.amazonaws.com`, or `sns-signing.<region>.amazonaws.com` for newer opt-in regions; GovCloud, China, ISO and EU sovereign names are in `sns-http/SOURCES.md`). Apply the same host rule to `SubscribeURL` before GETting it.
3. Fetch the PEM over HTTPS and cache it by URL. Extract the RSA public key. On Workers there is no `X509Certificate`, so this needs a small DER parse to the SPKI before `crypto.subtle.importKey("spki", …, { name: "RSASSA-PKCS1-v1_5", hash })`.
4. Build the string to sign:
   - Notification: `Message, MessageId, Subject (if present), Timestamp, TopicArn, Type`.
   - SubscriptionConfirmation and UnsubscribeConfirmation: `Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type`.
   - Format each field as `Key\nValue\n`. "The complete string to sign ends with a single trailing newline character after the last field's value."
5. Base64-decode `Signature` and verify RSASSA-PKCS1-v1_5 with SHA-1 (v1) or SHA-256 (v2).
6. Optionally pin `TopicArn` ("Reject any message with an unexpected TopicArn to prevent spoofing").

**Raw message delivery** (`x-amz-sns-rawdelivery: true`): the body is the bare S3 event with **no signature**, so fail closed unless the user explicitly opts out of verification.

**Retries:** "By default, if the initial delivery fails, Amazon SNS attempts up to three retries with a delay between failed attempts set at 20 seconds."

**Verdict: ready to implement.** 8 real AWS-signed messages (SubscriptionConfirmation v1, UnsubscribeConfirmation v2, Notification v1 and v2, with and without Subject) and both signing certs are included and verify offline. Tests must not check cert expiry against the wall clock: `SimpleNotificationService-7506…` expires 2026-10-14, and `7ff5…` expired in 2022.

---

## Verdicts

| Provider | Verdict | Reason |
| --- | --- | --- |
| b2 | ready to implement | Documented payload and HMAC; SDK-sourced signed vector. Map hide markers to deleted. |
| tigris | ready to implement | Documented payload; auth is a static header. `OBJECT_RENAME` needs live capture. |
| supabase | ready to implement | Documented envelope and row; handle UPDATE overwrites. Live capture recommended for the exact row serialization. |
| cloudinary | ready to implement (legacy signature) | Doc and SDK vectors verify. EdDSA `X-Cld-Signature_v2` needs live capture. |
| appwrite | ready to implement | Documented and e2e-tested HMAC-SHA1(URL + body). The body is assembled from the documented model. |
| box | ready to implement (upload + signature) | Doc payload and SDK vectors. TRASHED/DELETED shapes need live capture. Webhooks cannot target folder 0. |
| uploadthing | not feasible | No delete event, and no callback for files-sdk writes. |
| sns-http | ready to implement | Real signed messages and certs verify offline. Raw delivery is unsigned. |
