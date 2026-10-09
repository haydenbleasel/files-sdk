# uploadthing/ fixture sources (UploadThing upload callback)

Fetched 2026-10-08. UploadThing has **no bucket-notification or webhook product**. The only server-to-server request is the **upload callback** that the UploadThing API sends to the `callbackUrl` registered for a file-route upload. Its body is checked against an SDK schema and run as `onUploadComplete`. The docs publish no example body, so the payload below is taken from the official SDK test suite. `.body` files are byte-exact because the HMAC covers the raw bytes.

| Fixture | Source | Edits |
| --- | --- | --- |
| `callback.body` | Payload of `"forwards correct args to onUploadComplete handler"` in pingdotgg/uploadthing (MIT), `packages/uploadthing/test/node/request-handler.test.ts`, https://github.com/pingdotgg/uploadthing/blob/main/packages/uploadthing/test/node/request-handler.test.ts. Constants are from `packages/uploadthing/test/__test-helpers.ts`: `appId: "app-1"`, `UTFS_URL = "https://utfs.io"`, `UFS_HOST = "ufs.sh"`. | **Edited.** In the test, `file` is an `UploadedFileData` class instance. Here it is a plain object with keys in schema field order (`name, size, type, customId, key, url, appUrl, ufsUrl, fileHash`) from `packages/uploadthing/src/_internal/shared-schemas.ts`. The key order of real UploadThing-server bodies is unknown and does not matter for verification. |
| `callback.headers.json` | Header names: `uploadthing-hook: callback` and `x-uploadthing-signature`, from the same test and from https://docs.uploadthing.com/uploading-files ("You can identify the hook by the presence of the `uploadthing-hook` header and verify it using the `x-uploadthing-signature` header."). | **Computed.** The signature was computed with the test API key `sk_foo` (`__test-helpers.ts`), the same way the test does (`signPayload(payload, testToken.decoded.apiKey)`). |
| `error.body` / `error.headers.json` | Shape from `handleErrorRequest` in `packages/uploadthing/src/_internal/handler.ts`: `Schema.Struct({ fileKey: Schema.String, error: Schema.String })`, hook value `"error"` (`UploadThingHook = S.Literal("callback", "error")`). | **Derived.** The `error` text is a placeholder. The signature is computed with `sk_foo`. |
| `signing.json` | Algorithm from `packages/shared/src/crypto.ts`: `signaturePrefix = "hmac-sha256="`, `{ name: "HMAC", hash: "SHA-256" }`, key = UTF-8 bytes of the API key, data = raw body text, hex digest. | Computed values for both bodies. |

## Signature, quoted

From https://docs.uploadthing.com/uploading-files ("Handling the callback request"):

> "The signature is a HMAC SHA256 of the request body signed using your API key, which you can verify to ensure the request is authentic and originates from the UploadThing server."

From https://docs.uploadthing.com/concepts/auth-security:

> "The callback data is signed (HMAC SHA256) using the API key that uploaded the file. Since `v6.7` of the Uploadthing SDK, the callback data is automatically verified before executing the callback."

The API key is the `apiKey` field (`sk_...`) inside the base64-JSON `UPLOADTHING_TOKEN` (`ParsedToken` in `shared-schemas.ts`). There is no timestamp, so there is no replay window.

## When a callback is sent

The callback goes to the `callbackUrl` that is registered with the upload through `POST https://{region}.ingest.uploadthing.com/route-metadata`, using `{ fileKeys, metadata, callbackUrl, callbackSlug, awaitServerData, isDev }`. A file router does this automatically. With `isDev: true`, no callback is sent; the chunks are streamed back as `{ payload, signature, hook }` for the dev server to replay. See https://docs.uploadthing.com/uploading-files.

`files-sdk/uploadthing` uploads with `utapi.uploadFiles` on the server, and `signedUploadUrl()` builds ingest URLs without registering route metadata (`src/uploadthing/index.ts`). So **writes made through files-sdk produce no callback.** UploadThing has **no delete notification of any kind**.
