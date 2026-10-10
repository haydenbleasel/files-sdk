// Google Cloud Storage notifications: Pub/Sub messages (`JSON_API_V1`, pulled,
// pushed, or as the client library hands them over) and Eventarc CloudEvents
// (binary mode — `ce-*` headers over the object resource — or structured).
//
// Object names arrive unencoded. One storage change can reach a subscriber as
// several Pub/Sub messages with different ids, so the event id comes from the
// bucket, object, generation and event type, never the message id.

import { isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import type { Delivery, EventParser, RawEvent } from "./types.js";
import {
  bareEtag,
  malformed,
  pubsubText,
  stampOf,
  toSize,
  toTime,
} from "./types.js";

const CE_PREFIX = "google.cloud.storage.object.v1.";

// `data` is base64 text in JSON, or a Buffer when the Node client library
// hands the message over.
const decodeData = (
  data: JsonValue | Uint8Array | undefined
): JsonObject | undefined => {
  const text = pubsubText(data, "gcs");
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    throw malformed("gcs", "message data is not a JSON object resource");
  }
};

interface ObjectChange {
  type: "created" | "deleted";
  /** What the provider called it, for the id: `OBJECT_FINALIZE`, `deleted`, … */
  kind: string;
  bucket: string | undefined;
  name: string;
  generation: string | undefined;
  time: number;
  /** The provider's own timestamp, exactly as sent, for the id. */
  sentAt: JsonValue | undefined;
  /**
   * What identifies the change when it has no generation or timestamp: the
   * Pub/Sub attributes or the object resource, never the message (whose id
   * differs between duplicate deliveries of one change).
   */
  identity: JsonValue;
  resource: JsonObject | undefined;
  raw: JsonValue;
}

/**
 * How long before the event a deleted generation's `timeDeleted` must be for
 * it to count as already noncurrent. Deleting a live object stamps both with
 * the moment of the delete; the margin absorbs rounding and clock drift.
 */
const NONCURRENT_MARGIN_MS = 60 * 1000;

/**
 * Whether a permanent delete removed a generation that had already stopped
 * being live (a lifecycle `numNewerVersions` / `daysSinceNoncurrentTime`
 * cleanup, or a delete naming a noncurrent generation): the resource's
 * `timeDeleted`, when it became noncurrent, predates the event itself. Its
 * key may well have a live generation, so the delete isn't reported. GCS
 * documents no other marker of a noncurrent generation; without a payload
 * (`payloadFormat: NONE`) there's no telling, so the delete is reported.
 */
const wasNoncurrent = (
  resource: JsonObject | undefined,
  sentAt: JsonValue | undefined
): boolean =>
  toTime(sentAt, Number.NaN) - toTime(resource?.timeDeleted, Number.NaN) >
  NONCURRENT_MARGIN_MS;

const toEvent = (change: ObjectChange): RawEvent => {
  const { resource } = change;
  const size = toSize(resource?.size);
  const etag = bareEtag(resource?.etag);
  const contentType = resource?.contentType;
  return {
    id: `${change.kind}:${change.bucket ?? ""}/${change.name}#${change.generation ?? stampOf(change.identity, change.sentAt)}`,
    key: change.name,
    raw: change.raw,
    time: change.time,
    type: change.type,
    ...(change.bucket !== undefined && { bucket: change.bucket }),
    ...(change.generation !== undefined && { versionId: change.generation }),
    ...(change.type === "created" && size !== undefined && { size }),
    ...(etag !== undefined && { etag }),
    ...(isString(contentType) && { contentType }),
  };
};

/**
 * `created` / `deleted` for a Pub/Sub `eventType`, or `undefined`. A delete or
 * archive that carries `overwrittenByGeneration` is the old generation of an
 * overwrite — its `OBJECT_FINALIZE` arrives separately — so it's skipped.
 * `OBJECT_ARCHIVE` otherwise means the live version of a versioned object
 * became noncurrent: deleted, from the caller's side. (An `OBJECT_DELETE` of
 * a generation that was already noncurrent is skipped too; see
 * {@link wasNoncurrent}.)
 */
const pubsubType = (
  eventType: string,
  attributes: JsonObject
): "created" | "deleted" | undefined => {
  if (eventType === "OBJECT_FINALIZE") {
    return "created";
  }
  if (
    (eventType === "OBJECT_DELETE" || eventType === "OBJECT_ARCHIVE") &&
    attributes.overwrittenByGeneration === undefined
  ) {
    return "deleted";
  }
  return undefined;
};

const fromPubSub = (
  message: JsonObject,
  attributes: JsonObject
): RawEvent[] => {
  const { bucketId, eventType, objectGeneration, objectId } = attributes;
  if (!(isString(eventType) && isString(objectId))) {
    throw malformed("gcs", "attributes without eventType or objectId");
  }
  const type = pubsubType(eventType, attributes);
  if (!type) {
    return [];
  }
  const resource = decodeData(message.data);
  if (
    eventType === "OBJECT_DELETE" &&
    wasNoncurrent(resource, attributes.eventTime)
  ) {
    return [];
  }
  return [
    toEvent({
      bucket: isString(bucketId) ? bucketId : undefined,
      generation: isString(objectGeneration) ? objectGeneration : undefined,
      identity: attributes,
      kind: eventType,
      name: objectId,
      raw: message,
      resource,
      sentAt: attributes.eventTime,
      time: toTime(attributes.eventTime, Date.now()),
      type,
    }),
  ];
};

/**
 * `created` / `deleted` for an Eventarc `ce-type`. `archived` is skipped: with
 * no `overwrittenByGeneration` in a CloudEvent, an overwrite of a versioned
 * object can't be told from a delete — use Pub/Sub notifications on versioned
 * buckets.
 */
const cloudEventType = (ceType: string): "created" | "deleted" | undefined => {
  if (ceType === `${CE_PREFIX}finalized`) {
    return "created";
  }
  return ceType === `${CE_PREFIX}deleted` ? "deleted" : undefined;
};

const fromCloudEvent = (
  attrs: {
    type: string;
    subject: JsonValue | undefined;
    source: JsonValue | undefined;
    id: JsonValue | undefined;
    time: JsonValue | undefined;
  },
  data: JsonValue | undefined,
  raw: JsonValue
): RawEvent[] => {
  const type = cloudEventType(attrs.type);
  if (!type) {
    return [];
  }
  const resource = isJsonObject(data) ? data : undefined;
  if (type === "deleted" && wasNoncurrent(resource, attrs.time)) {
    return [];
  }
  const fromSubject =
    isString(attrs.subject) && attrs.subject.startsWith("objects/")
      ? attrs.subject.slice("objects/".length)
      : undefined;
  const name = isString(resource?.name) ? resource.name : fromSubject;
  if (name === undefined) {
    throw malformed("gcs", "CloudEvent without an object name");
  }
  const bucketFromSource =
    isString(attrs.source) && attrs.source.includes("/buckets/")
      ? attrs.source.slice(attrs.source.lastIndexOf("/buckets/") + 9)
      : undefined;
  return [
    toEvent({
      bucket: isString(resource?.bucket) ? resource.bucket : bucketFromSource,
      generation: isString(resource?.generation)
        ? resource.generation
        : undefined,
      identity: resource ?? { source: attrs.source, subject: attrs.subject },
      kind: attrs.type.slice(CE_PREFIX.length),
      name,
      raw,
      resource,
      sentAt: attrs.time,
      time: toTime(attrs.time, Date.now()),
      type,
    }),
  ];
};

const fromValue = (value: JsonValue, headers?: Headers): RawEvent[] => {
  if (!isJsonObject(value)) {
    throw malformed("gcs", "expected an object");
  }
  // Binary-mode CloudEvent: the attributes ride in `ce-*` headers.
  const ceType = headers?.get("ce-type");
  if (ceType?.startsWith(CE_PREFIX)) {
    return fromCloudEvent(
      {
        id: headers?.get("ce-id") ?? undefined,
        source: headers?.get("ce-source") ?? undefined,
        subject: headers?.get("ce-subject") ?? undefined,
        time: headers?.get("ce-time") ?? undefined,
        type: ceType,
      },
      value,
      value
    );
  }
  if (isString(value.specversion) && isString(value.type)) {
    return fromCloudEvent(
      {
        id: value.id,
        source: value.source,
        subject: value.subject,
        time: value.time,
        type: value.type,
      },
      value.data,
      value
    );
  }
  if (isJsonObject(value.attributes)) {
    return fromPubSub(value, value.attributes);
  }
  // A push delivery or a pulled `receivedMessages[]` entry wraps `message`.
  if (isJsonObject(value.message)) {
    return fromValue(value.message);
  }
  if (isJsonArray(value.receivedMessages)) {
    return value.receivedMessages.flatMap((item) => fromValue(item));
  }
  throw malformed("gcs", "no Pub/Sub attributes or CloudEvent type");
};

export const gcsParser: EventParser = {
  format: "gcs",
  parse: ({ body, headers }: Delivery) => fromValue(body, headers),
};
