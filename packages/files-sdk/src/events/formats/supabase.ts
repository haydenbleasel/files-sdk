// Supabase Storage has no storage webhook of its own; changes are rows in
// `storage.objects`, so a Database Webhook on that table delivers them:
// `{ type: "INSERT" | "UPDATE" | "DELETE", schema, table, record, old_record }`.
// Storage upserts, so an overwrite arrives as an UPDATE (new `version`), and a
// move as an UPDATE that changes `name`. Database Webhooks aren't signed; add
// an `Authorization: Bearer <token>` header to the webhook and use
// `verify: { token }`.

import { isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonObject } from "../../internal/json.js";
import type { EventParser, RawEvent } from "./types.js";
import { bareEtag, malformed, toSize, toTime } from "./types.js";

interface ObjectRow {
  id: string;
  name: string;
  bucket: string | undefined;
  version: string;
  metadata: JsonObject;
  row: JsonObject;
}

const rowOf = (value: JsonValue | undefined): ObjectRow | undefined => {
  if (!(isJsonObject(value) && isString(value.name))) {
    return undefined;
  }
  return {
    bucket: isString(value.bucket_id) ? value.bucket_id : undefined,
    id: isString(value.id) ? value.id : value.name,
    metadata: isJsonObject(value.metadata) ? value.metadata : {},
    name: value.name,
    row: value,
    version: isString(value.version) ? value.version : "",
  };
};

const created = (row: ObjectRow, raw: JsonObject, id: string): RawEvent => {
  const size = toSize(row.metadata.size);
  const etag = bareEtag(row.metadata.eTag);
  const { mimetype } = row.metadata;
  return {
    id,
    key: row.name,
    raw,
    time: toTime(row.row.updated_at ?? row.row.created_at, Date.now()),
    type: "created",
    ...(row.bucket !== undefined && { bucket: row.bucket }),
    ...(size !== undefined && { size }),
    ...(etag !== undefined && { etag }),
    ...(isString(mimetype) && { contentType: mimetype }),
  };
};

// A deleted row carries no deletion time.
const deleted = (row: ObjectRow, raw: JsonObject, id: string): RawEvent => ({
  id,
  key: row.name,
  raw,
  time: Date.now(),
  type: "deleted",
  ...(row.bucket !== undefined && { bucket: row.bucket }),
});

const missingRow = (): never => {
  throw malformed("supabase", "change without the storage.objects row");
};

const fromChange = (body: JsonObject): RawEvent[] => {
  if (body.schema !== "storage" || body.table !== "objects") {
    // A webhook shared with other tables: not a storage change.
    return [];
  }
  const record = rowOf(body.record);
  const old = rowOf(body.old_record);
  const idOf = (row: ObjectRow, suffix = ""): string =>
    `${String(body.type)}:${row.id}:${row.version}${suffix}`;
  switch (body.type) {
    case "INSERT": {
      return record ? [created(record, body, idOf(record))] : missingRow();
    }
    case "DELETE": {
      return old ? [deleted(old, body, idOf(old))] : missingRow();
    }
    case "UPDATE": {
      if (!(record && old)) {
        return missingRow();
      }
      if (record.name !== old.name || record.bucket !== old.bucket) {
        return [
          deleted(old, body, idOf(record, ":from")),
          created(record, body, idOf(record, ":to")),
        ];
      }
      const rewritten =
        record.version !== old.version ||
        bareEtag(record.metadata.eTag) !== bareEtag(old.metadata.eTag);
      // Otherwise only bookkeeping changed (last_accessed_at, user_metadata).
      return rewritten ? [created(record, body, idOf(record))] : [];
    }
    default: {
      throw malformed("supabase", `unknown change type ${String(body.type)}`);
    }
  }
};

export const supabaseParser: EventParser = {
  format: "supabase",
  parse: ({ body }) => fromChange(body),
};
