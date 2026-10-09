// The contract every notification parser implements. A parser is a pure
// function from one delivery to zero or more raw events keyed by the *storage*
// key; the plugin then stamps `source`/`provider`, filters by bucket, and
// folds each event through the instance (prefix, plugin `event` hooks).

import type { Adapter } from "../../index.js";
import { FilesError } from "../../internal/errors.js";
import type { FileEvent } from "../../internal/events.js";
import { isNumber, isString } from "../../internal/is.js";
import type { JsonObject, JsonValue } from "../../internal/json.js";

/** A notification format `files-sdk/events` can read. */
export type EventFormat =
  | "s3"
  | "r2"
  | "gcs"
  | "azure"
  | "b2"
  | "tigris"
  | "supabase"
  | "cloudinary"
  | "appwrite"
  | "box"
  | "memory";

/**
 * One delivery: a decoded JSON object (arrays arrive split into one delivery
 * per element), plus the HTTP headers when it came in as a request.
 */
export interface Delivery {
  body: JsonObject;
  headers?: Headers;
}

/** A parsed event before the plugin maps it onto the instance. */
export type RawEvent = Omit<FileEvent, "source" | "provider"> & {
  /** The bucket / container the notification is for, when the delivery says. */
  bucket?: string;
};

/** What a parser may read about the instance: the adapter, for formats whose keys depend on its config (Box's root folder, Cloudinary's resource type). */
export interface ParseContext {
  adapter: Adapter;
}

/** A webhook delivery to check against a provider signature. */
export interface SignatureCheck {
  /** The raw body, exactly as received. */
  body: string;
  headers: Headers;
  secret: string;
  /** Box's secondary signature key. */
  secondarySecret?: string;
  /** Appwrite signs the webhook URL as configured, so the verifier needs it. */
  url?: string;
  /** ms since the epoch, for timestamp freshness checks. */
  now: number;
}

export interface EventParser {
  readonly format: EventFormat;
  /** Normalize one delivery. Events the format reports that aren't a create or delete parse to nothing. */
  parse: (delivery: Delivery, context: ParseContext) => RawEvent[];
  /**
   * Check the provider's own delivery signature (`verify: { secret }`),
   * throwing `Unauthorized` when it doesn't match. Formats without one take a
   * shared `token` instead.
   */
  verifySignature?: (check: SignatureCheck) => Promise<void>;
  /**
   * A webhook handshake the format requires before it delivers (Event Grid's
   * subscription validation, the CloudEvents `OPTIONS` abuse-protection check).
   * Returns the response to send, or `undefined` for an ordinary delivery.
   */
  handshake?: (
    req: Request,
    deliveries: readonly Delivery[]
  ) => Response | undefined;
}

/** A delivery that isn't the shape the format documents. Permanent: redelivering it won't help. */
export const malformed = (format: EventFormat, detail: string): FilesError =>
  new FilesError(
    "Provider",
    `files-sdk/events: not a ${format} notification (${detail})`,
    undefined,
    { permanent: true }
  );

/** A delivery whose credential or signature doesn't check out. */
export const unauthorized = (detail: string): FilesError =>
  new FilesError("Unauthorized", `files-sdk/events: ${detail}`, undefined, {
    permanent: true,
  });

/** Parse a timestamp the way providers send them (ISO 8601 or epoch ms), else `fallback`. */
export const toTime = (
  value: JsonValue | undefined,
  fallback: number
): number => {
  if (isNumber(value) && Number.isFinite(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

/** A size providers send as a number or a decimal string. */
export const toSize = (value: JsonValue | undefined): number | undefined => {
  if (isNumber(value) && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (isString(value) && /^\d+$/u.test(value)) {
    return Number(value);
  }
  return undefined;
};

/** An ETag without its surrounding quotes (the SDK reports them bare). */
export const bareEtag = (value: JsonValue | undefined): string | undefined => {
  if (!isString(value) || value === "") {
    return undefined;
  }
  return value.replace(/^(?:W\/)?"(?<tag>.*)"$/u, "$<tag>");
};
