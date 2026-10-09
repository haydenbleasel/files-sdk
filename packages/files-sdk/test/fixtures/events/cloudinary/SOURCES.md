# cloudinary/ fixture sources (Cloudinary webhook notifications)

Fetched 2026-10-08. The code samples on cloudinary.com are URL-encoded JSON inside `data-props` attributes. They were decoded programmatically, parsed, and re-serialized with 2-space indentation, which matches the doc's own formatting. `.body` files are byte-exact.

| Fixture | Source | Edits |
| --- | --- | --- |
| `upload.json` | "Here's an example POST request sent by Cloudinary after an upload completes", section "Notification Payload", https://cloudinary.com/documentation/notifications | None. This is the body part of the snippet. |
| `upload.headers.json` | Header part of the same snippet (`X-Cld-Timestamp: 1719310887`, `X-Cld-Signature: f2292bdc1b0c99e16cb677af81dc94da6e36eae3`, `Content-Type: application/json`). | None. **It does not verify**, because the doc does not publish the account's API secret. Use `signing.json` vectors for signature tests. |
| `upload-simple.json` | "Upload (simple)" under "Notification response examples", same page. | None |
| `delete.json` | "Delete an asset", same page. | None. There is no top-level `timestamp` or `request_id`; the only time is `notification_context.triggered_at`. `resources` is an array, so one notification can carry several deleted assets. |
| `rename.json` | "Rename (Change the public ID)", same page. | None. It has `from_public_id` and `to_public_id`. |
| `sdk-sha256-vector.body` | `JSON.stringify(expected_parameters)` in the `verifyNotificationSignature` tests of cloudinary/cloudinary_npm (MIT), https://github.com/cloudinary/cloudinary_npm/blob/master/test/utils/utils_spec.js | None. The bytes are `{"public_id":"b8sjhoslj8cq8ovoa0ma","version":"1555337587","width":1000,"height":800}`. |
| `sdk-sha256-vector.headers.json` | Same test: `api_secret: 'hardcoded'`, `signature_algorithm: 'sha256'`, timestamp `7952342400000`, signature `6c5a29fd8815772fbac2f10ae741e093d0859313947ef8fadeb29126ded6649c`. | Header names come from the doc. The SDK test passes the timestamp in milliseconds (`7952342400000` is year 2222). A real `X-Cld-Timestamp` is in seconds. |
| `signing.json` | Both vectors: the doc's worked SHA-1 example (body `{public_id: 'sample'}`, timestamp `1315060510`, secret `abcd` gives `25f7e91709c858b97d688ce8da799dedb290d9ef`), https://cloudinary.com/documentation/notification_signatures, and the SDK SHA-256 vector. | None. Both were re-verified locally on 2026-10-08. The doc body is not valid JSON, so it only exists as a string in `signing.json`. |

## Signature, quoted

From https://cloudinary.com/documentation/notification_signatures:

> "The signature is a hexadecimal message digest (hash value) created with the SHA-1 or SHA-256 (Secure Hash Algorithm) cryptographic function."
>
> 1. "Create a single string containing the entire response body"
> 2. "Append the X-Cld-Timestamp value on the end of the string."
> 3. "Append your API secret to the end of the string."
> 4. "Create a hexadecimal message digest (hash value) of the string using an SHA function."
>
> "If you've established a dedicated API key for all your webhook notifications, make sure to employ the associated api_secret for verification. Otherwise, use the oldest active key in your product environment."
>
> "You should also compare the timestamp value with the current time to make sure that the signature was generated within a reasonable amount of time (e.g., within the last 2 hours)."

This is a **plain hash of body + timestamp + secret, not an HMAC**. The Node SDK does the same: `compute_hash(data + timestamp + api_secret, signature_algorithm, 'hex')`, with a default `valid_for = 7200` seconds (`lib/utils/index.js`).

## New signing scheme (EdDSA v2), not yet verifiable

https://cloudinary.com/documentation/notifications ("Per-trigger webhook signing (auth_scheme)") now documents a per-trigger `auth_scheme`:

| auth_scheme | Headers |
| --- | --- |
| `default` | `X-Cld-Timestamp`, `X-Cld-Signature`, `X-Cld-Signature_v2` ("Sends both the legacy HMAC-SHA1 signature and EdDSA v2 signing") |
| `legacy_hmac` | `X-Cld-Timestamp`, `X-Cld-Signature` |
| `eddsa_v2` | `X-Cld-Timestamp`, `X-Cld-Signature_v2` ("Ed25519 / EdDSA v2 signing using a Cloudinary-managed key pair (legacy HMAC not sent)") |

The table calls the legacy scheme "HMAC-SHA1", but the verification page describes a plain SHA digest. The SDKs implement the plain digest. No doc found publishes the EdDSA public key, its encoding, or what bytes it signs. A trigger can also set a Mustache `payload_template` that replaces the body entirely. **Live capture needed** for `X-Cld-Signature_v2`.
