// Backblaze B2 Event Notifications: a webhook POST of `{ events: [...] }`
// (one to fifty per delivery), optionally signed with an HMAC-SHA256 of the
// raw body in `X-Bz-Event-Notification-Signature: v1=<hex>`.
//
// A delete through `files-sdk/backblaze-b2` (the S3 API, no version id)
// leaves a hide marker rather than removing the version, so it arrives as
// `b2:HideMarkerCreated:Hide` — a delete from the caller's side.
// `b2:ObjectDeleted:*` is always one file version going
// (`b2_delete_file_version`, an S3 delete with a version id, a lifecycle rule
// pruning old versions): the file may still have a live version, so it isn't
// reported.

import { isNumber, isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import { hmac, timingSafeEqual, toHex, utf8 } from "../crypto.js";
import type { EventParser, RawEvent } from "./types.js";
import { malformed, stampOf, toSize, toTime, unauthorized } from "./types.js";

const typeOf = (eventType: string): "created" | "deleted" | undefined => {
  if (eventType.startsWith("b2:ObjectCreated:")) {
    return "created";
  }
  if (eventType.startsWith("b2:HideMarkerCreated:")) {
    return "deleted";
  }
  // b2:ObjectDeleted:* (one version, not the file), b2:TestEvent,
  // b2:MultipartUploadCreated:*, and types B2 adds later.
  return undefined;
};

const fromEvent = (event: JsonValue): RawEvent[] => {
  if (!isJsonObject(event)) {
    throw malformed("b2", "expected an event object");
  }
  const { eventType, objectName } = event;
  if (!isString(eventType)) {
    throw malformed("b2", "event without eventType");
  }
  const type = typeOf(eventType);
  if (!type) {
    // Including b2:TestEvent, which names no object.
    return [];
  }
  if (!isString(objectName)) {
    throw malformed("b2", "event without objectName");
  }
  // B2 reports 0 for a hide marker; on a delete, size isn't the caller's.
  const size = type === "created" ? toSize(event.objectSize) : undefined;
  return [
    {
      id: isString(event.eventId)
        ? event.eventId
        : `${eventType}:${objectName}@${stampOf(event, event.objectVersionId, event.eventTimestamp)}`,
      key: objectName,
      raw: event,
      time: toTime(event.eventTimestamp, Date.now()),
      type,
      ...(isString(event.bucketName) && { bucket: event.bucketName }),
      ...(size !== undefined && { size }),
      ...(isString(event.objectVersionId) && {
        versionId: event.objectVersionId,
      }),
    },
  ];
};

const fromBody = (body: JsonObject): RawEvent[] => {
  if (isJsonArray(body.events)) {
    return body.events.flatMap(fromEvent);
  }
  // One event, already taken out of its envelope.
  if ("eventType" in body && isNumber(body.eventVersion)) {
    return fromEvent(body);
  }
  throw malformed("b2", "expected events[]");
};

export const b2Parser: EventParser = {
  format: "b2",
  parse: ({ body }) => fromBody(body),
  verifySignature: async ({ body, headers, secret }) => {
    const header = headers.get("x-bz-event-notification-signature");
    if (!header) {
      throw unauthorized("missing X-Bz-Event-Notification-Signature");
    }
    const expected = toHex(await hmac("SHA-256", secret, utf8(body)));
    const ok = header
      .split(",")
      .map((part) => part.trim())
      .some(
        (part) =>
          part.startsWith("v1=") && timingSafeEqual(part.slice(3), expected)
      );
    if (!ok) {
      throw unauthorized("B2 signature does not match");
    }
  },
};
