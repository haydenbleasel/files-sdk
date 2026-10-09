# tigris/ fixture sources (Tigris Object Notifications)

Fetched 2026-10-08 (the doc page says "Last updated on Sep 10, 2026"). `.json` files were re-serialized with 2-space indentation, so whitespace can differ from the source.

| Fixture | Source | Edits |
| --- | --- | --- |
| `notification.json` | "An example notification payload is:", https://www.tigrisdata.com/docs/buckets/object-notifications/ (source: https://github.com/tigrisdata/tigris-os-docs/blob/main/docs/buckets/object-notifications.md, Apache-2.0) | None. One delivery holds one `OBJECT_CREATED_PUT` and one `OBJECT_DELETED` event. |
| `notification.headers.json` | "Webhook Authentication" on the same page: `Authorization: Bearer <token>` | **Placeholder.** The token value is made up. The doc shows no other request headers. Content-Type is not documented. |
| `notification-basic.headers.json` | Same section: `Authorization: Basic <base64 encoded username:password>` | **Placeholder.** `dXNlcjpwYXNz` is base64 of `user:pass`, the credentials in the official Go example's usage comment (`basicAuth("user", "pass", eventReceiver)`), https://www.tigrisdata.com/docs/sdks/s3/aws-go-sdk/#object-notifications |

## Facts parsers need, quoted from the doc page

- Payload is **not** S3 `Records[]`-shaped. It has its own `{ "events": [ { eventVersion, eventSource, eventName, eventTime, bucket, object: { key, size, eTag } } ] }` shape.
- Event names: "OBJECT_CREATED_PUT", "OBJECT_CREATED_MULTIPART", "OBJECT_CREATED_COPY", "OBJECT_DELETED", "OBJECT_TRANSITIONED", "OBJECT_RENAME". The doc gives no payload example for `OBJECT_RENAME`, so the old and new key fields are unknown. The official TS SDK type (`tigrisdata/storage`, `packages/storage/src/lib/bucket/types.ts`, MIT) lists only `OBJECT_CREATED_PUT` and `OBJECT_DELETED`, plus an open `string`.
- "eventTime ... Timestamp of the event in RFC3339 format".
- There is **no event id**, no version id and no content type in the payload.
- There is **no signature**. Authentication is only Basic or Bearer in `Authorization`, set in the dashboard.
- Delivery: "A 2xx status code acknowledges the request was successful. Any other status is treated as a failure and retried." and "If a webhook request takes longer than 10 seconds the request will be aborted and retried."
- Ordering: "Tigris Object Notifications are designed to be delivered at least once ... notifications can be sent out of order ... The Last-Modified timestamp can be used to determine the order of the events." The trigger-pipelines use case also says to use "the `Last-Modified` timestamp on the object (not `eventTime`)", https://github.com/tigrisdata/tigris-os-docs/blob/main/docs/use-cases/trigger-pipelines.mdx
- Filtering is a SQL-like `WHERE` with an extra `Event-Type` field, for example ``WHERE `Event-Type` = "OBJECT_DELETED"``.
