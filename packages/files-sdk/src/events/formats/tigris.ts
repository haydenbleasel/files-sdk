// Tigris object notifications: a webhook POST of `{ events: [...] }` in
// Tigris's own shape (not S3 `Records[]`). Deliveries carry no signature, only
// the `Authorization` header you configure, so authenticate with
// `verify: { token }`. There's no event id; one is derived from the change.

import { isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import type { EventParser, RawEvent } from "./types.js";
import { bareEtag, malformed, toSize, toTime } from "./types.js";

const typeOf = (eventName: string): "created" | "deleted" | undefined => {
  switch (eventName) {
    case "OBJECT_CREATED_PUT":
    case "OBJECT_CREATED_MULTIPART":
    case "OBJECT_CREATED_COPY": {
      return "created";
    }
    case "OBJECT_DELETED": {
      return "deleted";
    }
    default: {
      // OBJECT_TRANSITIONED (a storage-class change), and OBJECT_RENAME,
      // whose payload doesn't name the old key.
      return undefined;
    }
  }
};

const fromEvent = (event: JsonValue): RawEvent[] => {
  if (!isJsonObject(event)) {
    throw malformed("tigris", "expected an event object");
  }
  const { eventName, object } = event;
  if (!(isString(eventName) && isJsonObject(object) && isString(object.key))) {
    throw malformed("tigris", "event without eventName or object.key");
  }
  const type = typeOf(eventName);
  if (!type) {
    return [];
  }
  const etag = bareEtag(object.eTag);
  const size = toSize(object.size);
  const time = toTime(event.eventTime, Date.now());
  const bucket = isString(event.bucket) ? event.bucket : undefined;
  return [
    {
      id: `${eventName}:${bucket ?? ""}/${object.key}@${etag ?? ""}#${time}`,
      key: object.key,
      raw: event,
      time,
      type,
      ...(bucket !== undefined && { bucket }),
      ...(etag !== undefined && { etag }),
      ...(size !== undefined && type === "created" && { size }),
    },
  ];
};

const fromBody = (body: JsonObject): RawEvent[] => {
  if (isJsonArray(body.events)) {
    return body.events.flatMap(fromEvent);
  }
  if (body.eventSource === "tigris") {
    return fromEvent(body);
  }
  throw malformed("tigris", "expected events[]");
};

export const tigrisParser: EventParser = {
  format: "tigris",
  parse: ({ body }) => fromBody(body),
};
