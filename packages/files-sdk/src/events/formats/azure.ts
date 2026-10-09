// Azure Blob Storage events through Event Grid, in either delivery schema:
// the Event Grid schema (`eventType`, `eventTime`) or CloudEvents 1.0 (`type`,
// `time`). The blob name comes from `subject`
// (`/blobServices/default/containers/<container>/blobs/<name>`). The webhook
// answers Event Grid's subscription validation and the CloudEvents `OPTIONS`
// abuse-protection handshake.

import { isNumber, isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonObject } from "../../internal/json.js";
import type { Delivery, EventParser, RawEvent } from "./types.js";
import { bareEtag, malformed, toTime } from "./types.js";

const SUBJECT =
  /^\/?blobServices\/default\/containers\/(?<container>[^/]+)\/blobs\/(?<name>.+)$/u;
const VALIDATION = "Microsoft.EventGrid.SubscriptionValidationEvent";

/** The APIs after which a `BlobCreated` blob holds its full data (ADLS `CreateFile` and SFTP `SftpCreate` fire on an empty blob first). */
const COMMITTED = new Set([
  "PutBlob",
  "PutBlockList",
  "CopyBlob",
  "FlushWithClose",
  "SftpCommit",
]);

// Event Grid stamps 7 fractional digits; keep milliseconds so every runtime's
// `Date.parse` accepts it.
const parseTime = (value: JsonValue | undefined): number =>
  toTime(
    isString(value) ? value.replace(/(?<ms>\.\d{3})\d+/u, "$<ms>") : value,
    Date.now()
  );

const fromSubject = (
  subject: JsonValue | undefined
): { container: string; name: string } | undefined => {
  const groups = isString(subject) ? SUBJECT.exec(subject)?.groups : undefined;
  const container = groups?.container;
  const name = groups?.name;
  return container && name ? { container, name } : undefined;
};

// A blob URL (`https://acct.blob.core.windows.net/<container>/<name>`, or the
// `dfs` endpoint) is percent-encoded, unlike `subject`.
const fromUrl = (
  url: JsonValue | undefined
): { container: string; name: string } | undefined => {
  if (!isString(url)) {
    return undefined;
  }
  try {
    const [container, ...rest] = new URL(url).pathname.slice(1).split("/");
    const name = rest.map((segment) => decodeURIComponent(segment)).join("/");
    return container && name ? { container, name } : undefined;
  } catch {
    return undefined;
  }
};

const missingBlob = (): never => {
  throw malformed("azure", "subject is not a blob path");
};

const fromEvent = (event: JsonObject): RawEvent[] => {
  const eventType = event.eventType ?? event.type;
  if (!isString(eventType)) {
    throw malformed("azure", "event without eventType/type");
  }
  const data = isJsonObject(event.data) ? event.data : {};
  const blob = fromSubject(event.subject);
  const time = parseTime(event.eventTime ?? event.time);
  const id = isString(event.id) ? event.id : undefined;
  const sequencer = isString(data.sequencer) ? data.sequencer : undefined;
  const base = (
    type: "created" | "deleted",
    where: { container: string; name: string },
    suffix = ""
  ): RawEvent => ({
    bucket: where.container,
    id: id
      ? `${id}${suffix}`
      : `${type}:${where.container}/${where.name}@${sequencer ?? time}`,
    key: where.name,
    raw: event,
    time,
    type,
  });

  switch (eventType) {
    case "Microsoft.Storage.BlobCreated": {
      if (!(blob && isString(data.api) && COMMITTED.has(data.api))) {
        return blob ? [] : missingBlob();
      }
      const etag = bareEtag(data.eTag);
      return [
        {
          ...base("created", blob),
          ...(isNumber(data.contentLength) && { size: data.contentLength }),
          ...(etag !== undefined && { etag }),
          ...(isString(data.contentType) && { contentType: data.contentType }),
        },
      ];
    }
    case "Microsoft.Storage.BlobDeleted": {
      return blob ? [base("deleted", blob)] : missingBlob();
    }
    case "Microsoft.Storage.BlobRenamed": {
      // ADLS / SFTP rename: `subject` is the destination.
      const source = fromUrl(data.sourceUrl);
      if (!(blob && source)) {
        return missingBlob();
      }
      return [
        base("deleted", source, ":source"),
        base("created", blob, ":destination"),
      ];
    }
    default: {
      // Validation/deletion lifecycle events, tier changes, directories,
      // policy completions: nothing happened to a blob's existence.
      return [];
    }
  }
};

const validationCode = (
  deliveries: readonly Delivery[]
): string | undefined => {
  for (const { body } of deliveries) {
    if (
      isJsonObject(body) &&
      body.eventType === VALIDATION &&
      isJsonObject(body.data) &&
      isString(body.data.validationCode)
    ) {
      return body.data.validationCode;
    }
  }
  return undefined;
};

export const azureParser: EventParser = {
  format: "azure",
  handshake: (req, deliveries) => {
    // CloudEvents webhook abuse protection: echo the origin, allow any rate.
    const origin = req.headers.get("webhook-request-origin");
    if (req.method === "OPTIONS" && origin) {
      return new Response(null, {
        headers: {
          Allow: "POST",
          "WebHook-Allowed-Origin": origin,
          "WebHook-Allowed-Rate": "*",
        },
        status: 200,
      });
    }
    const code = validationCode(deliveries);
    return code === undefined
      ? undefined
      : Response.json({ validationResponse: code });
  },
  parse: ({ body }) => fromEvent(body),
};
