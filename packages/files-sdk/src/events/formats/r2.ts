// Cloudflare R2 event notifications, delivered to a Queue. A consumer sees the
// notification as a message body — in a Worker, `message.body` (or the whole
// `Message`); over the HTTP pull API, a string body that may be base64. Keys
// arrive as stored: R2 doesn't document any encoding.

import { isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import type { EventParser, RawEvent } from "./types.js";
import { bareEtag, malformed, stampOf, toSize, toTime } from "./types.js";

const typeOf = (action: string): "created" | "deleted" | undefined => {
  switch (action) {
    case "PutObject":
    case "CopyObject":
    case "CompleteMultipartUpload": {
      return "created";
    }
    case "DeleteObject":
    case "LifecycleDeletion": {
      return "deleted";
    }
    default: {
      return undefined;
    }
  }
};

const fromNotification = (body: JsonObject): RawEvent[] => {
  const { action, object } = body;
  if (!(isString(action) && isJsonObject(object) && isString(object.key))) {
    throw malformed("r2", "expected action and object.key");
  }
  const type = typeOf(action);
  if (!type) {
    return [];
  }
  const etag = bareEtag(object.eTag);
  const size = toSize(object.size);
  const bucket = isString(body.bucket) ? body.bucket : undefined;
  // No event id: the notification's own time tells a re-upload of the same
  // bytes (same ETag) after a delete from the first upload.
  const stamp = stampOf(body, body.eventTime, etag);
  return [
    {
      id: `${type}:${bucket === undefined ? "" : `${bucket}/`}${object.key}@${stamp}`,
      key: object.key,
      raw: body,
      time: toTime(body.eventTime, Date.now()),
      type,
      ...(bucket !== undefined && { bucket }),
      ...(etag !== undefined && { etag }),
      ...(size !== undefined && { size }),
    },
  ];
};

const decodeText = (text: string): JsonValue => {
  try {
    // SAFETY: `JSON.parse` returns exactly the `JsonValue` value space.
    return JSON.parse(text) as JsonValue;
  } catch {
    // The pull API base64-encodes `json` and `bytes` message bodies.
    try {
      const bytes = Uint8Array.from(atob(text), (c) => c.codePointAt(0) ?? 0);
      // SAFETY: as above — the decoded text went through `JSON.parse`.
      return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
    } catch {
      throw malformed("r2", "message body is neither JSON nor base64 JSON");
    }
  }
};

const fromValue = (value: JsonValue): RawEvent[] => {
  if (isString(value)) {
    return fromValue(decodeText(value));
  }
  if (!isJsonObject(value)) {
    throw malformed("r2", "expected an object");
  }
  if ("action" in value && "object" in value) {
    return fromNotification(value);
  }
  // A pull-API response, or its `messages` array.
  const { result } = value;
  if (isJsonObject(result) && isJsonArray(result.messages)) {
    return result.messages.flatMap(fromValue);
  }
  if (isJsonArray(value.messages)) {
    return value.messages.flatMap(fromValue);
  }
  // A Worker `Message` or a pulled message: the notification is its body.
  if (value.body !== undefined) {
    return fromValue(value.body);
  }
  throw malformed("r2", "no action/object, message body, or messages[]");
};

export const r2Parser: EventParser = {
  format: "r2",
  parse: ({ body }) => fromValue(body),
};
