# appwrite/ fixture sources (Appwrite webhooks, storage file events)

Fetched 2026-10-08. Appwrite's docs (https://appwrite.io/docs/advanced/platform/webhooks) publish **no example request body** for a file event. They only say "All event payloads mirror the payloads for the API payload". So the bodies here are **assembled** from the documented File model, as described below. `.body` files are byte-exact because the signature covers them.

| Fixture | Source | Edits |
| --- | --- | --- |
| `file-create.body` | **Assembled.** Every value is the documented `example` of the File response model, in model rule order: `src/Appwrite/Utopia/Response/Model/File.php` in https://github.com/appwrite/appwrite (BSD-3-Clause), published as https://appwrite.io/docs/references/cloud/models/file. Datetimes use `Model::TYPE_DATETIME_EXAMPLE` (`2020-10-15T06:38:00.000+00:00`). | **Assembled.** It is encoded like PHP `json_encode()` with default flags, so `/` is escaped as `\/`. The worker builds the body with `json_encode($payload['payload'])` in `src/Appwrite/Platform/Workers/Webhooks.php`. The model includes the new `folder` and `key` fields, which are on the published model page. |
| `file-delete.body` | Same body. The official e2e test `testDeleteBucketFile` asserts that the delete delivery carries the deleted file document (`$id`, `name`, `signature`, `mimeType`, `sizeOriginal`), `tests/e2e/Services/ProjectWebhooks/WebhooksBase.php`. | Same as above. |
| `file-create.headers.json`, `file-delete.headers.json` | Header names are from the docs "Headers" table and from `Webhooks.php`. That file also sends `X-Appwrite-Webhook-Delivery-Id`, which the docs table does not list yet. `User-Agent` is the exact value asserted by the e2e test: `Appwrite-Server vdev. Please report abuse at security@appwrite.io` (`APP_USERAGENT` = `"Appwrite-Server v%s. Please report abuse at %s"`). | **Partly placeholder.** Webhook id, name, project id and delivery id are placeholders. `x-appwrite-webhook-events` holds exactly the 10 event strings the e2e test asserts for a file create or delete. Their **order is unverified**, because the worker joins them with `,` in generation order. `x-appwrite-webhook-signature` is **computed** (see `signing.json`). |
| `signing.json` | Algorithm from the docs "Verification" section and `Webhooks.php`: `base64_encode(hash_hmac('sha1', $rawUrl . $payload, $signatureKey, true))`. | **Computed.** URL `https://example.com/webhook` is the URL in the docs' Node sample. Secret `new-key-after-rotation` is the custom secret used in the official e2e test `testSecretRotationZeroDowntime` (`tests/e2e/Services/Webhooks/WebhooksBase.php`). The expected signature was computed locally. |

## Signature, quoted

From https://appwrite.io/docs/advanced/platform/webhooks ("Verification"):

> 1. "Concatenate the **webhook URL** and the **request body** (no spaces in between)."
> 2. "Generate an HMAC-SHA1 hash of the concatenated string using your webhook's **signature key**."
> 3. "Base64 encode the resulting hash."
> 4. "Compare the result to the `X-Appwrite-Webhook-Signature` header value. If they match, the payload is authentic."

The URL is the webhook's configured `url` attribute, byte for byte (`$rawUrl` in the worker). It is not the URL the receiver sees after proxies or rewrites, so the verifier must be told the configured URL. HTTP Basic auth is optional (`httpUser`/`httpPass`, sent with `withBasicAuth`). Secrets are 8 to 256 characters when user-supplied, or 128 random characters when generated (`assertSame(128, strlen(...signatureKey))` in the e2e test). Timeout: 15 s (`withTimeout(15)`).

## Event names

From the e2e test, a file create delivery's `X-Appwrite-Webhook-Events` contains all of: `buckets.*`, `buckets.*.files.*`, `buckets.*.files.*.create`, `buckets.*.files.{fileId}`, `buckets.*.files.{fileId}.create`, `buckets.{bucketId}`, `buckets.{bucketId}.files.*`, `buckets.{bucketId}.files.*.create`, `buckets.{bucketId}.files.{fileId}`, `buckets.{bucketId}.files.{fileId}.create`. Delete uses the same set with `.delete`, and metadata changes use `.update`.
