# azure/ fixture sources (Blob Storage → Event Grid)

Fetched 2026-10-08. Event examples come from https://learn.microsoft.com/en-us/azure/event-grid/event-schema-blob-storage (ms.date 2025-10-21, page updated 2026-03-25). The source is https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/event-grid/event-schema-blob-storage.md, and the live page was checked and matches. JSON files were re-serialized with 2-space indentation.

| Fixture | Source section | Edits |
| --- | --- | --- |
| `eventgrid-created.json` | Blob Storage events → Event Grid event schema → `Microsoft.Storage.BlobCreated` | None. `data.api` is `"PutBlockList"`. |
| `eventgrid-deleted.json` | Event Grid event schema → `Microsoft.Storage.BlobDeleted` | None. `data.api` is `"DeleteBlob"`. No `eTag` or `contentLength`. |
| `cloudevents-created.json` | Cloud event schema → `Microsoft.Storage.BlobCreated` | None. The doc shows it as a one-element **array**. |
| `cloudevents-deleted.json` | Cloud event schema → `Microsoft.Storage.BlobDeleted` | None. Array. |
| `eventgrid-created-adls.json` | Data Lake Storage Gen 2 events → Event Grid event schema → BlobCreated | None. `data.api` is `"CreateFile"`, with `contentLength: 0`, `contentOffset: 0`, `dataVersion: "2"` and a `dfs.core.windows.net` url. |
| `eventgrid-renamed.json` | Data Lake Storage Gen 2 events → Event Grid event schema → `Microsoft.Storage.BlobRenamed` | None. `data.api` is `"RenameFile"`, with `sourceUrl` and `destinationUrl`. The subject is the **destination** path. |
| `subscription-validation.json` | https://learn.microsoft.com/en-us/azure/event-grid/end-point-validation-event-grid-events-schema ("Validation details") | None |
| `subscription-validation.response.json` | Same page: "echo back the validation code in the `validationResponse` property" | None |
| `subscription-validation.headers.json` | Same page: "The event includes a header with the value `aeg-event-type: SubscriptionValidation`." The content type is from https://learn.microsoft.com/en-us/azure/event-grid/cloud-event-schema: "For Event Grid schema, that header value is `"content-type":"application/json; charset=utf-8"`." | `aeg-subscription-name` is a placeholder. The header name is documented but no example value is. |
| `eventgrid-created.headers.json` | Header names from the "Message headers" table (include on https://learn.microsoft.com/en-us/azure/event-grid/receive-events) | **Placeholders and derived values.** `aeg-event-type: Notification` comes from the documented value set. `aeg-metadata-version`/`aeg-data-version` copy the payload's `metadataVersion`/`dataVersion`. `aeg-subscription-name` is a placeholder. No doc shows a full header capture. |
| `cloudevents-created.headers.json` | Same table, plus "For CloudEvents schema, that header value is `"content-type":"application/cloudevents+json; charset=utf-8"`" | As above. `aeg-metadata-version` is "the spec version" for the cloud event schema, per the table. |
| `cloudevents-options-handshake.headers.json` | **Request** headers for the `OPTIONS` validation. `WebHook-Request-Origin` is the example from https://learn.microsoft.com/en-us/azure/event-grid/end-point-validation-cloud-events-schema. `WebHook-Request-Callback` and `WebHook-Request-Rate` are the examples from the CloudEvents spec that page links to, https://github.com/cloudevents/spec/blob/v1.0/http-webhook.md#4-abuse-protection (§4.1.3, §4.1.4). | The Azure page lists only `WebHook-Request-Origin`. **The origin value Event Grid actually sends is not documented by Microsoft**; `eventemitter.example.com` is the generic doc example. |

## Expected responses

Event Grid schema `SubscriptionValidation` (POST): reply **HTTP 200** with the body below (`subscription-validation.response.json`).

```json
{ "validationResponse": "512d38b6-c7b8-40c8-89fe-f46f9e9622b6" }
```

The doc says: "You must return an HTTP 200 OK response status code. HTTP 202 Accepted isn't recognized as a valid Event Grid subscription validation response. The HTTP request must complete within 30 seconds." The alternative is a manual `GET` on `data.validationUrl` within 10 minutes (port 553). The JS sample on https://learn.microsoft.com/en-us/azure/event-grid/receive-events replies `{ "ValidationResponse": code }` with a capital `V`, which suggests the property name is matched case-insensitively; use the documented lower-case form.

CloudEvents `OPTIONS` handshake: reply with these headers.

```
HTTP/1.1 200 OK
WebHook-Allowed-Origin: eventemitter.example.com
WebHook-Allowed-Rate: *
Allow: POST
```

- Azure page: "If and only if the delivery target does allow delivery of the events, it MUST reply to the request by including the `WebHook-Allowed-Origin` and `WebHook-Allowed-Rate` headers."
- `WebHook-Allowed-Origin`: "Its value MUST either be the origin name supplied in the `WebHook-Request-Origin` header, or a singular asterisk character ('*')". **Doc typo:** both the Azure page and spec v1.0 then show the `*` example as `WebHook-Request-Origin: *` when they mean `WebHook-Allowed-Origin: *`.
- `WebHook-Allowed-Rate` (spec §4.2.2): "MUST be returned if the request contained the `WebHook-Request-Rate`, otherwise it SHOULD be returned … either an asterisk character or the string representation of a positive integer number".
- `Allow` (spec §4.2): "The OPTIONS response SHOULD include the Allow header indicating the POST method being permitted."
- Callback grant (spec §4.1.3): "The delivery target grants permission by issuing an HTTPS GET or POST request against the given URL." If the target grants by callback, "it withholds the response headers".
- Status code: the spec says the "handshake cannot rely on status codes", and a target that does not handle OPTIONS "SHOULD respond with HTTP status code 405". The troubleshooting page (https://learn.microsoft.com/en-us/azure/event-grid/troubleshoot-subscription-validation) only says: "Your endpoint must respond to the HTTP OPTIONS method and return the `WebHook-Allowed-Origin` header."

## Batching and arrays

From https://learn.microsoft.com/en-us/azure/event-grid/delivery-and-retry: "Event Grid defaults to sending each event individually to subscribers. The subscriber receives an array with a single event." The blob schema page shows CloudEvents examples as arrays too. However, the single sample on https://learn.microsoft.com/en-us/azure/event-grid/cloud-event-schema is a bare object. Accept both.

## Paths and encoding

- Subject format (https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-event-overview): `/blobServices/default/containers/<containername>/blobs/<blobname>`.
- **Leading slash is inconsistent:** the cloud-event-schema page sample uses `"subject": "blobServices/default/containers/{storage-container}/blobs/{new-file}"`, with no leading `/`.
- **Doc inconsistency:** in the BlobCreated example, `subject` says container `test-container` while `data.url` says `testcontainer`. Derive the key from `subject`, not `url`.
- Percent-encoding of blob names in `subject` or `data.url` is **not documented** anywhere I could find. All examples use plain ASCII names.

## ADLS Gen2 / SFTP

- ADLS Gen2 `BlobCreated` fires for `CreateFile` and `FlushWithClose`. The page says: "if you want to ensure that the Microsoft.Storage.BlobCreated event is triggered only when a Block Blob is completely committed, filter the event for the `FlushWithClose` REST API call."
- `BlobDeleted` uses `api: "DeleteFile"`. `BlobRenamed` uses `RenameFile` (and `SftpRename`).
- `DirectoryCreated`, `DirectoryRenamed` and `DirectoryDeleted` exist (`recursive` is the string `"true"`).
- SFTP: `SftpCreate` (empty blob on open), `SftpWrite` and `SftpCommit`. The page says "SFTP uploads will generate 2 events".
