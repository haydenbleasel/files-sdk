# box/ fixture sources (Box webhooks v2)

Fetched 2026-10-08. `.json` files were re-serialized with 2-space indentation. `.body` files are byte-exact because the HMAC covers the raw bytes.

| Fixture | Source | Edits |
| --- | --- | --- |
| `file-uploaded.json` | "Payload body" example, https://developer.box.com/guides/webhooks/v2/ (source: `content/guides/webhooks/v2/index.md` in https://github.com/box/developer.box.com, Apache-2.0) | None |
| `file-uploaded.headers.json` | "Payload headers" example on the same page. | None. **It cannot be verified**, because the doc does not publish the signature keys. The doc also does not say these headers belong to the body example. |
| `sdk-vector.body` / `.headers.json` | `testWebhookValidation` in box/box-node-sdk (Apache-2.0), `src/test/webhooks.test.ts`, https://github.com/box/box-node-sdk/blob/main/src/test/webhooks.test.ts. Body, `box-delivery-id`, `box-delivery-timestamp`, and both expected signatures are copied verbatim. | None. Both signatures were re-verified locally on 2026-10-08. |
| `sdk-vector.signing.json` | Same test: `primaryKey = 'SamplePrimaryKey'`, `secondaryKey = 'SampleSecondaryKey'`, `incorrectKey = 'IncorrectKey'`. | None |
| `sdk-vector-unicode.body` / `.headers.json` | Same test, `bodyWithJapanese` + `headersWithJapanese` (primary signature `LV2uCu+5NJtIHrCXDYgZ0v/PP5THGRuegw3RtdnEyuE=`). | **Edited.** In the TS source the string holds raw Japanese characters, and the SDK signs it after `jsonStringifyWithEscapedUnicode()` (non-ASCII becomes lowercase `\uXXXX`, `/` becomes `\/`). The `.body` file stores that escaped form, which is what Box sends on the wire. The signature verifies against these bytes and **not** against the raw-character form. The unrelated `box-signature-secondary` from the SDK's header object was dropped. |
| `file-trashed.derived.json` | Derived from `file-uploaded.json`, reshaped as Box's Trashed File resource (https://developer.box.com/reference/resources/trash-file/, fetched 2026-10-09): `path_collection` is "A list of parent folders for an item in the trash" and the doc example holds only `{ "name": "Trash", "sequence_id": null, "etag": null }`, while `parent` stays the folder the file was in. | **Derived, not from a doc.** `trigger` set to `FILE.TRASHED`; `path_collection` replaced by a single Trash entry (id `1` is made up); `item_status: "trashed"`, `trashed_at` and `purged_at` set; `parent` kept. Box publishes no `FILE.TRASHED` webhook payload, so whether `source` takes this shape is an assumption. **Live capture needed.** |
| `file-deleted.derived.json` | Derived from `file-uploaded.json`. | **Derived, not from a doc.** Only `trigger` was changed. A permanently deleted item may carry a reduced `source`. **Live capture needed.** |

## Signature, quoted

From https://developer.box.com/guides/webhooks/v2/signatures-v2/:

> "Check if the timestamp in the `BOX-DELIVERY-TIMESTAMP` header of the payload is not older than ten minutes."
>
> "Ensure you append the bytes of the payload body first, and then the bytes of the timestamp found in the `BOX-DELIVERY-TIMESTAMP` header."
>
> "Convert the HMAC to a `Base64` encoded digest."
>
> "Compare the value of the `BOX-SIGNATURE-PRIMARY` header to the digest created with the primary key, and the value of the `BOX-SIGNATURE-SECONDARY` header to the digest created with the secondary key. Make sure to use a timing-safe comparison between signatures to prevent timing attacks."

From https://developer.box.com/guides/webhooks/v2/: `BOX-SIGNATURE-VERSION` "Value is always `1`." `BOX-SIGNATURE-ALGORITHM` "Value is always `HmacSHA256`." The SDK returns no signature (fails) if either differs.

Two doc problems to know about:

- The doc's Node and Python comparison samples swap the headers. They compare `digest1` (primary key) with `BOX-SIGNATURE-SECONDARY` and `digest2` with `BOX-SIGNATURE-PRIMARY`. The prose and the SDK pair primary with primary.
- The SDK (`WebhooksManager.validateMessage`, `src/managers/webhooks.ts`) rejects timestamps older than `maxAge` (default 600 s) **and any timestamp in the future**, with no skew allowance. It verifies against the raw body first and then against the escaped form, to cope with frameworks that re-serialize JSON.

## Other facts

- Dedupe: body `id` "When Box retries a webhook this ID will not change". `BOX-DELIVERY-ID` changes on every retry.
- Retries: "Box will retry webhook deliveries up to 12 times over a period of 2 hours." A delivery fails without a 2xx within 30 seconds.
- Triggers (https://developer.box.com/guides/webhooks/triggers/): `FILE.UPLOADED` "A file is uploaded or moved to this folder", `FILE.TRASHED` "A file is moved to trash", `FILE.DELETED` "A file is permanently deleted", `FILE.RESTORED`, `FILE.COPIED`, `FILE.MOVED`, `FILE.RENAMED`, plus folder triggers.
- Limitations (https://developer.box.com/guides/webhooks/v2/limitations-v2/): "V2 webhooks cannot be created on the root folder, which is the folder with ID `0`." There is one webhook per item per app per user. If the app's session expires, deliveries switch to trigger `NO_ACTIVE_SESSION` without a full payload.
