// Cloudinary webhook notifications (`notification_url` / triggers). Keys are
// `public_id`s within one resource type, so events for another resource type
// or delivery type than the adapter's are dropped. The legacy signature is a
// plain SHA-1 or SHA-256 hex digest of `body + X-Cld-Timestamp + api_secret`
// (not an HMAC); EdDSA (`X-Cld-Signature_v2`) isn't publicly documented, so
// deliveries carrying only that fail closed.

import { isNumber, isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import type { HashName } from "../crypto.js";
import { digest, timingSafeEqual, toHex, utf8 } from "../crypto.js";
import type { EventParser, ParseContext, RawEvent } from "./types.js";
import {
  bareEtag,
  malformed,
  stampOf,
  toSize,
  toTime,
  unauthorized,
} from "./types.js";

/** How old a signed delivery may be (Cloudinary's SDKs default to 2 hours). */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const trimMicros = (value: JsonValue | undefined): JsonValue | undefined =>
  isString(value) ? value.replace(/(?<ms>\.\d{3})\d+/u, "$<ms>") : value;

/** The resource and delivery type the adapter stores under; unset means any. */
interface CloudinaryScope {
  resourceType?: string;
  type?: string;
}

/** The resource and delivery type the adapter stores under (`raw` / `upload` by default). */
const scopeOf = (context: ParseContext): CloudinaryScope => {
  const { adapter } = context;
  if (adapter.name !== "cloudinary") {
    return {};
  }
  return {
    ...("resourceType" in adapter &&
      isString(adapter.resourceType) && { resourceType: adapter.resourceType }),
    ...("type" in adapter && isString(adapter.type) && { type: adapter.type }),
  };
};

const inScope = (resource: JsonObject, scope: CloudinaryScope): boolean =>
  (scope.resourceType === undefined ||
    resource.resource_type === scope.resourceType) &&
  (scope.type === undefined ||
    resource.type === undefined ||
    resource.type === scope.type);

const contentTypeOf = (resource: JsonObject): string | undefined => {
  const { format } = resource;
  if (!isString(format)) {
    return undefined;
  }
  if (
    resource.resource_type === "image" ||
    resource.resource_type === "video"
  ) {
    return `${resource.resource_type}/${format}`;
  }
  return undefined;
};

/** `notification_context.triggered_at`, exactly as sent. */
const triggeredAt = (body: JsonObject): JsonValue | undefined =>
  isJsonObject(body.notification_context)
    ? body.notification_context.triggered_at
    : undefined;

const fromUpload = (body: JsonObject): RawEvent[] => {
  if (!isString(body.public_id)) {
    throw malformed("cloudinary", "upload notification without public_id");
  }
  const time = toTime(
    body.created_at,
    toTime(trimMicros(triggeredAt(body)), Date.now())
  );
  const size = toSize(body.bytes);
  const etag = bareEtag(body.etag);
  const contentType = contentTypeOf(body);
  return [
    {
      id: isString(body.request_id)
        ? body.request_id
        : `upload:${String(body.asset_id)}@${stampOf(body, body.created_at, triggeredAt(body))}`,
      key: body.public_id,
      raw: body,
      time,
      type: "created",
      ...(size !== undefined && { size }),
      ...(etag !== undefined && { etag }),
      ...(isString(body.version_id) && { versionId: body.version_id }),
      ...(contentType !== undefined && { contentType }),
    },
  ];
};

const fromDelete = (body: JsonObject, scope: CloudinaryScope): RawEvent[] => {
  if (!isJsonArray(body.resources)) {
    throw malformed("cloudinary", "delete notification without resources[]");
  }
  const time = toTime(trimMicros(triggeredAt(body)), Date.now());
  const stamp = stampOf(body, triggeredAt(body));
  return body.resources.flatMap((resource) => {
    if (!(isJsonObject(resource) && isString(resource.public_id))) {
      throw malformed("cloudinary", "deleted resource without public_id");
    }
    if (!inScope(resource, scope)) {
      return [];
    }
    return [
      {
        id: `delete:${String(resource.asset_id ?? resource.public_id)}@${stamp}`,
        key: resource.public_id,
        raw: body,
        time,
        type: "deleted" as const,
      },
    ];
  });
};

const fromRename = (body: JsonObject): RawEvent[] => {
  const from = body.from_public_id;
  const to = body.to_public_id;
  if (!(isString(from) && isString(to))) {
    throw malformed("cloudinary", "rename notification without public ids");
  }
  const time = toTime(trimMicros(triggeredAt(body)), Date.now());
  const id = isString(body.request_id)
    ? body.request_id
    : `rename:${String(body.asset_id)}@${stampOf(body, triggeredAt(body))}`;
  return [
    { id: `${id}:from`, key: from, raw: body, time, type: "deleted" },
    { id: `${id}:to`, key: to, raw: body, time, type: "created" },
  ];
};

const fromBody = (body: JsonObject, context: ParseContext): RawEvent[] => {
  const scope = scopeOf(context);
  switch (body.notification_type) {
    case "upload": {
      return inScope(body, scope) ? fromUpload(body) : [];
    }
    case "delete": {
      return fromDelete(body, scope);
    }
    case "rename": {
      return inScope(body, scope) ? fromRename(body) : [];
    }
    default: {
      if (!isString(body.notification_type)) {
        throw malformed("cloudinary", "no notification_type");
      }
      // eager, moderation, folders, access control, …: no object came or went.
      return [];
    }
  }
};

/** The digest a hex signature's length implies, or `undefined` for neither. */
const digestOf = (signature: string): HashName | undefined => {
  if (signature.length === 64) {
    return "SHA-256";
  }
  if (signature.length === 40) {
    return "SHA-1";
  }
  return undefined;
};

export const cloudinaryParser: EventParser = {
  format: "cloudinary",
  parse: ({ body }, context) => fromBody(body, context),
  verifySignature: async ({ body, headers, now, secret }) => {
    const signature = headers.get("x-cld-signature");
    const timestamp = headers.get("x-cld-timestamp");
    if (!signature) {
      throw unauthorized(
        headers.has("x-cld-signature_v2")
          ? "only an X-Cld-Signature_v2 (EdDSA) signature, which can't be verified; use the default or legacy auth scheme on the trigger"
          : "missing X-Cld-Signature"
      );
    }
    const seconds = Number(timestamp);
    if (!(timestamp && isNumber(seconds) && Number.isFinite(seconds))) {
      throw unauthorized("missing X-Cld-Timestamp");
    }
    if (Math.abs(now - seconds * 1000) > MAX_AGE_MS) {
      throw unauthorized("Cloudinary delivery is too old");
    }
    const hash = digestOf(signature);
    if (!hash) {
      throw unauthorized(
        "Cloudinary signature is not a SHA-1 or SHA-256 digest"
      );
    }
    const expected = toHex(
      await digest(hash, utf8(`${body}${timestamp}${secret}`))
    );
    if (!timingSafeEqual(signature.toLowerCase(), expected)) {
      throw unauthorized("Cloudinary signature does not match");
    }
  },
};
