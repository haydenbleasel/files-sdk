// Amazon S3 (and MinIO) bucket notifications, in every envelope a consumer
// receives them:
//
// - the event itself, `{ Records: [{ eventSource: "aws:s3", s3 }] }` — Lambda's
//   S3 trigger, or an S3-compatible service's (MinIO's `minio:s3` webhook,
//   Wasabi's `wasabi:s3` via SNS, RustFS's webhook, whose records name no
//   `eventSource`), `eventName` optionally `s3:`-prefixed;
// - an SQS message (`{ Records: [{ eventSource: "aws:sqs", body }] }`, or one
//   such record) whose `body` is the event, an SNS envelope around it
//   (`{ Type: "Notification", Message }`), or an EventBridge event;
// - EventBridge's own shape (`{ source: "aws.s3", "detail-type", detail }`).
//
// `Records[]` keys are URL-encoded with `+` for spaces (MinIO's too, via Go's
// `url.QueryEscape`); EventBridge keys are not. `s3:TestEvent` (sent when a
// notification is first configured) parses to nothing.

import { isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import type { Delivery, EventParser, RawEvent } from "./types.js";
import { bareEtag, malformed, toSize, toTime } from "./types.js";

const decodeKey = (key: string): string => {
  try {
    return decodeURIComponent(key.replaceAll("+", " "));
  } catch {
    throw malformed("s3", `object key is not URL-encoded: ${key}`);
  }
};

const decodeJson = (text: string): JsonValue => {
  try {
    // SAFETY: `JSON.parse` returns exactly the `JsonValue` value space.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw malformed("s3", "message body is not JSON");
  }
};

const field = (record: JsonObject, name: string): JsonObject | undefined => {
  const value = record[name];
  return isJsonObject(value) ? value : undefined;
};

/**
 * `created` / `deleted` for an S3 or MinIO `eventName`, or `undefined` for one
 * that doesn't create or remove the live object: tagging, ACL, restore,
 * replication and storage-class changes, MinIO's metadata-only
 * `ObjectCreated:Put{Tagging,Retention,LegalHold,Encryption}` and
 * `ObjectRemoved:NoOP`, and lifecycle expiry of a delete marker.
 */
export const s3EventType = (
  eventName: string
): "created" | "deleted" | undefined => {
  const name = eventName.replace(/^s3:/u, "");
  if (
    name === "ObjectCreated:Put" ||
    name === "ObjectCreated:Post" ||
    name === "ObjectCreated:Copy" ||
    name === "ObjectCreated:CompleteMultipartUpload"
  ) {
    return "created";
  }
  if (
    name === "ObjectRemoved:Delete" ||
    name === "ObjectRemoved:DeleteMarkerCreated" ||
    name === "ObjectRemoved:DeleteAllVersions" ||
    name === "LifecycleExpiration:Delete" ||
    name === "LifecycleExpiration:DeleteMarkerCreated"
  ) {
    return "deleted";
  }
  return undefined;
};

// One `Records[]` entry of the S3 event itself.
const fromRecord = (record: JsonObject): RawEvent[] => {
  const { eventName } = record;
  const s3 = field(record, "s3");
  const object = s3 && field(s3, "object");
  if (!(isString(eventName) && object && isString(object.key))) {
    throw malformed("s3", "record without eventName or s3.object.key");
  }
  const type = s3EventType(eventName);
  if (!type) {
    return [];
  }
  const key = decodeKey(object.key);
  const etag = bareEtag(object.eTag);
  const size = toSize(object.size);
  const bucket = s3 && field(s3, "bucket");
  const sequencer = isString(object.sequencer) ? object.sequencer : undefined;
  const versionId = isString(object.versionId) ? object.versionId : undefined;
  const time = toTime(record.eventTime, Date.now());
  return [
    {
      id: `${type}:${key}@${sequencer ?? versionId ?? etag ?? time}`,
      key,
      raw: record,
      time,
      type,
      ...(bucket && isString(bucket.name) && { bucket: bucket.name }),
      ...(etag !== undefined && { etag }),
      ...(size !== undefined && type === "created" && { size }),
      ...(versionId !== undefined && { versionId }),
      ...(isString(object.contentType) && { contentType: object.contentType }),
    },
  ];
};

/** `created` / `deleted` for an EventBridge `detail-type`, or `undefined`. */
const eventBridgeType = (
  detailType: JsonValue | undefined
): "created" | "deleted" | undefined => {
  if (detailType === "Object Created") {
    return "created";
  }
  if (detailType === "Object Deleted") {
    return "deleted";
  }
  return undefined;
};

// An EventBridge event from S3 (`source: "aws.s3"`).
const fromEventBridge = (event: JsonObject): RawEvent[] => {
  const type = eventBridgeType(event["detail-type"]);
  if (!type) {
    return [];
  }
  const detail = field(event, "detail");
  const object = detail && field(detail, "object");
  if (!(object && isString(object.key))) {
    throw malformed("s3", "EventBridge event without detail.object.key");
  }
  const bucket = detail && field(detail, "bucket");
  const etag = bareEtag(object.etag);
  const size = toSize(object.size);
  const versionId = object["version-id"];
  const sequencer = isString(object.sequencer) ? object.sequencer : undefined;
  const time = toTime(event.time, Date.now());
  return [
    {
      id: isString(event.id)
        ? event.id
        : `${type}:${object.key}@${sequencer ?? time}`,
      key: object.key,
      raw: event,
      time,
      type,
      ...(bucket && isString(bucket.name) && { bucket: bucket.name }),
      ...(etag !== undefined && { etag }),
      ...(size !== undefined && type === "created" && { size }),
      ...(isString(versionId) && { versionId }),
    },
  ];
};

const fromValue = (value: JsonValue): RawEvent[] => {
  if (!isJsonObject(value)) {
    throw malformed("s3", "expected an object");
  }
  // s3:TestEvent, bare or inside an SQS/SNS envelope.
  if (value.Event === "s3:TestEvent") {
    return [];
  }
  // SNS envelope (SNS → SQS with raw delivery off).
  if (isString(value.Type) && "TopicArn" in value) {
    return value.Type === "Notification" && isString(value.Message)
      ? fromValue(decodeJson(value.Message))
      : [];
  }
  if (value.source === "aws.s3" && "detail-type" in value) {
    return fromEventBridge(value);
  }
  // One SQS record.
  if (value.eventSource === "aws:sqs") {
    if (!isString(value.body)) {
      throw malformed("s3", "SQS record without a string body");
    }
    return fromValue(decodeJson(value.body));
  }
  // The S3 event record itself (one entry of Records[]).
  // The S3 event record itself: AWS's `aws:s3`, MinIO's `minio:s3`, Wasabi's
  // `wasabi:s3`, or RustFS's, which has no `eventSource` at all.
  const source = value.eventSource;
  if (
    (isString(source) && source.endsWith(":s3")) ||
    (source === undefined && "eventName" in value && "s3" in value)
  ) {
    return fromRecord(value);
  }
  if (isJsonArray(value.Records)) {
    return value.Records.flatMap(fromValue);
  }
  throw malformed(
    "s3",
    "no Records, SQS body, SNS Message or EventBridge detail"
  );
};

export const s3Parser: EventParser = {
  format: "s3",
  parse: (delivery: Delivery) => fromValue(delivery.body),
};
