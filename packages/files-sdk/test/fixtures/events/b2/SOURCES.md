# b2/ fixture sources (Backblaze B2 Event Notifications)

Fetched 2026-10-08. `.json` files were re-serialized with 2-space indentation (and may be reformatted by the repo's oxfmt), so whitespace can differ from the source. Values and key order are unchanged unless an edit is listed.

`.body` files are **byte-exact** request bodies (no trailing newline) because the HMAC covers the raw bytes. They deliberately do not use the `.json` extension, so `bun run fix` (oxfmt) never rewrites them. Read them as text or bytes.

| Fixture | Source | Edits |
| --- | --- | --- |
| `upload.json` | The webhook example under "Webhooks" in the Event Notifications Reference Guide (updated 07 Nov 2024), https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide | **Edited.** The doc truncates `objectVersionId` (`"4_zaea8c5bc362a..."`). It was completed with the full id that Backblaze's own Java SDK test uses for the same sample bucket: `4_zaea8c5bc362ae55070130333_f117c7bd5d6c6597c_d20230521_m235957_c001_v0001044_t0052_u01684713597235`. |
| `upload.headers.json` | Same doc example (`POST /sampleurl` block). | **Edited.** The doc block truncates the signature (`v1=2c86b8e1f15f41f8...`). It was replaced with the full example value printed one paragraph earlier: `v1=2c86b8e1f15f41f805f3331f3cf4eb20875be8887ab734b2cdccfa2350e5e231`. **It does not verify.** No secret is given for it, and the body is truncated. Use `signed-upload.*` for HMAC tests. |
| `captured-upload.json` / `.headers.json` | A real delivery captured by B2listen, an official Backblaze sample (MIT), README "The embedded HTTP server prints incoming event notification messages", https://github.com/backblaze-b2-samples/b2listen/blob/main/README.md | None. The rule had no signing secret, so there is no signature header. The `cf-*` and `x-forwarded-*` headers were added by the Cloudflare tunnel, not by B2. |
| `test-event.json` | `testToJsonAndBack_testEvent` in Backblaze/b2-sdk-java, `core/src/test/java/com/backblaze/b2/client/structures/B2EventNotificationEventTest.java`, https://github.com/Backblaze/b2-sdk-java (license: https://www.backblaze.com/using_b2_code.html) | **Edited.** The SDK test holds a single event object. It was wrapped in `{"events":[...]}` because every delivery has that envelope. The SDK enforces that test events have no `objectName`, `objectSize` or `objectVersionId`. |
| `signed-upload.body` | `DEFAULT_EVENT_PAYLOAD` in `B2EventNotificationTest.java` (same repo). | None. These are the exact UTF-8 bytes of the Java string literal (pretty-printed, `\n` newlines, no trailing newline). |
| `signed-upload.headers.json` | Header names and fixed values come from the reference guide example. | **Computed.** `x-bz-event-notification-signature` was computed with the documented algorithm and the SDK test secret `3XDfkdQte2OgA78qCtSD17LAzpj6ay9H` (`HMAC_SHA256_SIGNING_SECRET` in the same test file). Neither the doc nor the SDK publishes the resulting signature; the SDK computes it at test time with the same function. |
| `signed-upload.signing.json` | Secret, wrong secret (`HMAC_SHA256_SIGNING_SECRET2`) and expected header for the vector above. | Computed (see above). |
| `delete.derived.json` | Derived from `upload.json`. | **Derived, not from a doc.** Only `eventType` was changed, to `b2:ObjectDeleted:Delete`. `objectSize` is kept because the reference guide says "The objectSize is non-null on deletes". The Java SDK getter comment disagrees ("objectSize would be null for hide marker, delete, and test events"), so parsers must accept both. |
| `hide-marker.derived.json` | Derived from `upload.json`. | **Derived, not from a doc.** `eventType` was changed to `b2:HideMarkerCreated:Hide` and `objectSize` to `0`, per the guide: "The objectSize is 0 for hide markers". |

## Signature, quoted

From the reference guide, "Verifying the Webhook Request Signature":

> "The signature header value comprises the signature version, always v1, followed by an equals sign =, followed by the lowercase hex-encoded signature value."
>
> "To verify the signature, create an HMAC SHA-256 digest using the hmacSha256SigningSecret from the Event Notification rule as the key, with the request payload as the data. The resulting hex-encoded HMAC digest value must match the signature in the header."

The key is the UTF-8 bytes of the 32-character secret string. It is **not** base64-decoded, even though the doc's sample secret `MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0` looks like base64. Source: `SignatureUtils.computeHmacSha256Signature` in `core/src/main/java/com/backblaze/b2/client/structures/B2EventNotification.java`. The same SDK splits the header value on `,` and accepts a match on any part, so tolerate a comma-separated list.

## Test events

There are two conflicting official statements:

- The reference guide note says: "Test events use the signing secret established during rule creation."
- The guide's own JavaScript sample says: "Note - at present (4/15/24), test events need special handling * Test event requests are signed with a dummy key". The sample then skips verification for `b2:TestEvent`. That sample also reads `event.body.eventType`, which does not match the documented `events[]` envelope.

The "How to Create and Use Event Notifications" guide says the **Test Rule** button sends "the same JSON structure as a "real" notification message, but it includes an event type of b2:TestEvent. The test message contains a signature in the x-bz-event-notification-signature HTTP header." https://www.backblaze.com/docs/cloud-storage-create-and-use-event-notifications

Live capture is needed to know which key signs test events today.
