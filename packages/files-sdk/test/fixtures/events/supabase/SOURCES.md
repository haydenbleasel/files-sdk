# supabase/ fixture sources (Supabase Database Webhooks on `storage.objects`)

Fetched 2026-10-08. `.json` files were re-serialized with 2-space indentation, so whitespace can differ from what pg_net sends.

## Which feature

Supabase has **no user-facing Storage webhook or event feature** on the hosted platform. The supported route is a **Database Webhook** (a `pg_net` trigger) on the `storage.objects` table, as the official Hugging Face image-captioning guide does: "Create the Database Webhook ... to trigger the `huggingface-image-captioning` function anytime a record is added to the `storage.objects` table." https://supabase.com/docs/guides/ai/examples/huggingface-image-captioning

The Storage server does have its own webhook (`WEBHOOK_URL` / `WEBHOOK_API_KEY` env vars, events `ObjectCreated:Put|Post|Copy|Move`, `ObjectRemoved:Delete|Move`, `ObjectUpdated:Metadata`). The 2022 launch post says: "We haven't exposed these parameters on our platform yet ... If you're self-hosting then you can use them today." https://github.com/supabase/supabase/blob/master/apps/www/_blog/2022-12-13-storage-image-resizing-smart-cdn.mdx. It is one server-wide URL configured by env var, sent with `authorization: Bearer <WEBHOOK_API_KEY>` and no signature (`src/storage/events/lifecycle/webhook.ts`, https://github.com/supabase/storage, Apache-2.0). It is undocumented in the Supabase docs and not configurable on hosted projects, so no fixture was captured for it. Its body is `{ type: "Webhook", event: { $version, type, region, applyTime, payload: { bucketId, name, version, metadata, ... } }, sentAt, tenant: { ref, host } }`.

## Fixtures

| Fixture | Source | Edits |
| --- | --- | --- |
| `insert.json` | **Assembled.** (1) The envelope is the documented `InsertPayload` type, https://supabase.com/docs/guides/database/webhooks ("Payload"). Its exact construction is `jsonb_build_object('old_record', OLD, 'record', NEW, 'type', TG_OP, 'table', TG_TABLE_NAME, 'schema', TG_TABLE_SCHEMA)` in `supabase_functions.http_request()`, https://github.com/supabase/supabase/blob/master/docker/volumes/db/webhooks.sql. (2) `record` is the documented `storage.objects` row in the `remove()` response example of the official Python reference spec, https://github.com/supabase/supabase/blob/master/apps/docs/spec/supabase_py_v2.yml (`id: delete-file`). | **Edited.** The envelope keys are in jsonb output order (shorter keys first), because the payload is a `jsonb` value. The inner row keeps the doc's key order. A real `to_jsonb(NEW)` row probably also has `path_tokens` (text[]) and, on current Storage schemas, `level`, `archived_at`, `is_delete_marker` and `is_versioned` columns (migrations `0062-object-versioning-core.sql` etc. in supabase/storage). Its timestamps would be Postgres JSON format (`2024-10-25T15:52:13.993+00:00`), not `...Z`. The doc row's `owner: ""` is how the API serializes it; the column is a nullable uuid. **Live capture needed for exact column set and formatting.** |
| `delete.json` | Same sources. `DeletePayload` has `record: null` and `old_record: <row>`. | Same edits as `insert.json`. |
| `update-overwrite.derived.json` | Derived. | **Derived, not from a doc.** `record` is the doc row. `old_record` uses the metadata of the second documented row (the `list()` response example in the same spec, `eTag "c5e8c553235d9af30ef4f6e280790b92"`, size 32175) and a placeholder `version`. It models an overwrite, explained below. |
| `insert.headers.json` | `Content-Type: application/json` is the default header in `http_request()` (`webhooks.sql`). | **Placeholder.** `x-webhook-secret` stands in for whatever custom header the user adds. Supabase does not add one. |

## Overwrites arrive as UPDATE, not INSERT

`upsertObject` in https://github.com/supabase/storage/blob/master/src/storage/database/pg.ts runs `INSERT INTO storage.objects ... ON CONFLICT (bucket_id, name ...) DO UPDATE SET metadata = EXCLUDED.metadata, user_metadata = ..., version = ...`. On a conflict Postgres updates the existing row, so row-level **UPDATE** triggers fire for it and the INSERT webhook does not. See "If an INSERT contains an ON CONFLICT DO UPDATE clause, it is possible for row-level BEFORE INSERT and then BEFORE UPDATE triggers to be executed", https://www.postgresql.org/docs/current/trigger-definition.html. A webhook that listens only to INSERT misses `upload(..., { upsert: true })` overwrites.

## Auth

Database Webhooks have **no signature**. The only authentication is headers the user puts in the trigger definition (`TG_ARGV[2]`). The Dashboard adds `Authorization: Bearer <service key>` automatically only when the target is a Supabase Edge Function with `verify_jwt` on (`ensureEdgeFunctionAuthorizationHeader` in `apps/studio/components/interfaces/Database/Hooks/FormContents.tsx`, https://github.com/supabase/supabase). Delivery is one async `net.http_post` call with a default 1000 ms timeout (`TG_ARGV[4]`). `http_request()` has no retry logic. Logs are in the `net` schema (`net._http_response`). There is no event id in the payload.
