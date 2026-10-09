# Storage events (`files-sdk/events`)

React when a file is created or deleted, however it got there: provider bucket notifications, gateway uploads, and (opt-in) writes through the instance, all normalized into one `FileEvent` and routed to handlers. Full docs: bundled `docs/events/` and `docs/plugins/events.mdx` (or <https://files-sdk.dev/docs/events>).

## Install and handle

```ts
import { createFiles } from "files-sdk";
import { events } from "files-sdk/events";
import { s3 } from "files-sdk/s3";

export const files = createFiles({
  adapter: s3({ bucket: "uploads" }),
  plugins: [events()],
});

files.events.on("created", "avatars/**", async (e) => {
  /* e.key, e.size, e.etag, e.id */
});
files.events.on("deleted", async (e) => {
  /* … */
});
```

- Use `createFiles` (the namespace comes from `extend`). One `events()` per instance; put it first in `plugins`.
- `FileEvent`: `{ type: "created" | "deleted", key, size?, etag?, versionId?, contentType?, time, source: "provider" | "gateway" | "sdk", provider, id, raw }`. Keys are caller-facing (URL-decoded, instance `prefix` stripped; events outside the prefix are dropped).
- Two types only: overwrites are `created`, copies `created`, moves `deleted` + `created`; tagging/metadata/restore/storage-class changes are skipped.

## Delivery rules to tell the user

- **At least once, out of order, on every provider.** Handlers must be idempotent on `event.id` (an upsert keyed on it), or pass `events({ dedupe: { has, add } })` (checked before handlers, recorded after they all succeed; `dedupeTtl` default 24 h).
- A throwing handler makes `dispatch()` reject (after trying every event) and the webhook answer 500, so the provider redelivers. Every failure also goes to `onError` (default `console.error`).

## Consuming deliveries

| Provider | Adapter(s) | Wire it |
| --- | --- | --- |
| S3 → SQS / Lambda / SNS→SQS / EventBridge | `s3`, `s3-fetch` (against AWS; `bun-s3` or a custom endpoint needs `events({ format: "s3" })`) | `handler = (event) => files.events.dispatch(event)`; per-record `dispatch(record)` + `batchItemFailures` for partial retries |
| S3 → SNS → HTTPS | `s3` | `webhook({ verify: { sns: { topicArn, confirm: true } } })` |
| MinIO / RustFS webhook | `minio`, `rustfs` | `webhook({ verify: { token } })` (`auth_token` → `Authorization: Bearer`) |
| Wasabi → your AWS SNS topic | `wasabi` | SNS → SQS → `dispatch(record)`, or SNS → HTTPS with `verify: { sns }` |
| R2 → Queue | `r2` | Worker `queue()` → `dispatch(message.body)`, `ack()`/`retry()` per message |
| GCS → Pub/Sub | `gcs`, `firebase-storage` | pull: `dispatch(message)`; push: `webhook({ verify: { google: { audience, email } } })` |
| Azure → Event Grid | `azure` | `webhook({ verify: { token } })` with `?token=` in the endpoint URL; validation handshake answered automatically; route `OPTIONS` too for the CloudEvents schema |
| Backblaze B2 | `backblaze-b2` | `webhook({ verify: { secret } })` (HMAC-SHA256). files-sdk deletes arrive as `b2:HideMarkerCreated:*` → `deleted`; subscribe to them. |
| Tigris | `tigris` | `webhook({ verify: { token } })` (unsigned) |
| Supabase | `supabase` | Database Webhook on `storage.objects` (Insert/Update/Delete) with an `Authorization: Bearer` header → `webhook({ verify: { token } })`; set `events({ bucket })` |
| Cloudinary | `cloudinary` | `webhook({ verify: { secret: apiSecret } })`; EdDSA-only (`_v2`) triggers are refused |
| Appwrite | `appwrite` | `webhook({ verify: { secret, url } })` — `url` exactly as configured; needs the Request (event type is a header) |
| Box | `box` | `webhook({ verify: { secret: primaryKey, secondarySecret } })`; webhooks can't target folder `0`, so set `box({ rootFolderId })` to the watched folder |
| memory | `memory` | built in: writes emit events; `await files.events.settled()` in tests |

- `webhook()` returns `{ handle }`, mountable with any gateway binding (`createRouteHandler` from `files-sdk/next`, `hono`, …). `verify` is required (`false` only when something upstream authenticates). Status codes: 401 bad credential, 400 malformed, 500 handler failure (redelivery), 200 `{ received }`.
- The format comes from `files.capabilities.events` (`{ format } | false`), which each adapter declares per instance: `s3()` reads `"s3"` only against AWS (no custom `endpoint`); `bun-s3` declares nothing. Other S3-compatible services (Storj via Pub/Sub, Spaces, Hetzner, Scaleway, …) declare nothing (unverified, own format, or no notifications); opt in with `events({ format: "s3" })` only when the provider sends S3-shaped events. Parsing on an adapter with no format throws `Unsupported`; a malformed delivery throws `Invalid`. Adapters without notifications (Vercel Blob, Netlify Blobs, UploadThing, Dropbox, Drive, OneDrive, SharePoint, fs, …): use `events({ sdk: true })` (writes through this instance, not awaited) and gateway uploads.
- `events({ bucket })` drops other buckets' events on a shared endpoint.
- Debug a payload: `files events parse delivery.json --format s3` (stdin when no file).

## Composition

Plugins map provider events through `FilesPlugin.event`: `dedup()` drops its blobs, `encryption()`/`compression()` clear `size`, `versioning()`/`softDelete()` drop their prefixes, `tiering()` keeps hot-routed keys and refuses with `fallback: true` (webhook() then throws at startup). Gateway and `sdk` events skip these hooks.

## Gateway uploads

With the plugin installed on the gateway's `files`, every accepted upload (after `onUploadComplete`) reaches `on()` handlers as `source: "gateway"`, `id: "gateway:<uploadId>"`, keyed by the storage key (authorize's `keyPrefix` applied).
