// The memory adapter's own change notifications (`MemoryNotification`), so
// handlers can be exercised locally with no provider. The plugin subscribes to
// the adapter directly; `parse()` / `dispatch()` also accept a notification
// object, which is how a test can replay one.

import { isNumber, isString } from "../../internal/is.js";
import type { JsonObject } from "../../internal/json.js";
import type { EventParser, RawEvent } from "./types.js";
import { malformed, toSize, toTime } from "./types.js";

const toEvent = (body: JsonObject): RawEvent => {
  const { key, sequence, type } = body;
  if (!(isString(key) && isNumber(sequence))) {
    throw malformed("memory", "expected key and sequence");
  }
  if (type !== "created" && type !== "deleted") {
    throw malformed("memory", `unknown type ${String(type)}`);
  }
  const size = toSize(body.size);
  return {
    id: `${type}:${key}#${sequence}`,
    key,
    raw: body,
    time: toTime(body.time, Date.now()),
    type,
    ...(size !== undefined && { size }),
    ...(isString(body.etag) && { etag: body.etag }),
    ...(isString(body.contentType) && { contentType: body.contentType }),
  };
};

export const memoryParser: EventParser = {
  format: "memory",
  parse: ({ body }) => [toEvent(body)],
};
