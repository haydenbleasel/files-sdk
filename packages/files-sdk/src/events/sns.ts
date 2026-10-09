// Amazon SNS over HTTP(S) — S3 → SNS → your endpoint. SNS signs every message
// with an RSA key whose certificate is published at `SigningCertURL`: the
// string to sign is a fixed list of `Key\nValue\n` fields, verified with
// RSASSA-PKCS1-v1_5 over SHA-1 (`SignatureVersion` 1) or SHA-256 (2). The
// certificate is trusted because of where it comes from — an SNS host, over
// HTTPS — so that URL (and a `SubscribeURL` before visiting it) must be an
// SNS endpoint. Raw message delivery strips the signature, so it fails closed.
//
// A valid signature only proves SNS sent the message, for whichever topic
// published it, and any AWS account can publish S3-shaped JSON to a topic of
// its own. So the topic is pinned (required), and the signed `Timestamp` must
// be recent, so an old message can't be replayed. Both are checked before any
// certificate is fetched.

import { FilesError } from "../internal/errors.js";
import { isNumber, isString } from "../internal/is.js";
import type { JsonObject, JsonValue } from "../internal/json.js";
import { isJsonObject } from "../internal/json.js";
import { fromBase64, utf8 } from "./crypto.js";
import { unauthorized } from "./formats/types.js";
import { pemToDer, spkiOf } from "./x509.js";

export interface SnsVerifyOptions {
  /**
   * The topic ARN (or ARNs) deliveries must come from. Required: SNS signs a
   * message for any topic, including one an attacker owns, so without it a
   * forged S3 event on their topic would verify (and, with `confirm`, your
   * endpoint would subscribe to it). Checked on notifications and on
   * subscription messages alike.
   */
  topicArn: string | readonly string[];
  /**
   * Visit the `SubscribeURL` of a verified `SubscriptionConfirmation`, so a
   * new subscription starts delivering. Default `false`: the URL is logged
   * for you to confirm by hand (SNS sends nothing until you do).
   */
  confirm?: boolean;
  /**
   * How old a message's signed `Timestamp` may be, ms, so a captured message
   * can't be replayed later. Default one hour, the longest an SNS delivery
   * policy retries for. A `Timestamp` more than five minutes ahead of the
   * clock is refused too.
   */
  maxAge?: number;
  /** Clock for the `Timestamp` check. Defaults to `Date.now`. */
  now?: () => number;
  /** Fetches the signing certificate and the `SubscribeURL`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const SNS_HOST = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(?:\.cn)?$/u;
/** The default {@link SnsVerifyOptions.maxAge}. */
const MAX_AGE_MS = 60 * 60 * 1000;
/** Allowed clock drift ahead of a message's `Timestamp`. */
const SKEW_MS = 5 * 60 * 1000;
/** How many signing keys are kept. SNS uses one certificate per region at a time. */
const MAX_KEYS = 16;

const NOTIFICATION_FIELDS = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
];
const SUBSCRIPTION_FIELDS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

/**
 * An `https://sns.<region>.amazonaws.com[.cn]/…` URL on the default port with
 * no credentials, or `undefined`. With `pem`, a signing certificate's URL: a
 * `.pem` path and nothing after it (no query or fragment).
 */
export const snsUrl = (
  value: JsonValue | undefined,
  pem = false
): URL | undefined => {
  if (!isString(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const plain =
      url.protocol === "https:" &&
      SNS_HOST.test(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "";
    const certificate =
      url.pathname.endsWith(".pem") && url.search === "" && url.hash === "";
    return plain && (!pem || certificate) ? url : undefined;
  } catch {
    return undefined;
  }
};

export const stringToSign = (message: JsonObject): string => {
  const fields =
    message.Type === "Notification" ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  return fields
    .flatMap((field) => {
      const value = message[field];
      return isString(value) ? [`${field}\n${value}\n`] : [];
    })
    .join("");
};

/** The digest a `SignatureVersion` signs with, or `undefined` for an unknown one. */
const hashOf = (
  version: JsonValue | undefined
): "SHA-1" | "SHA-256" | undefined => {
  if (version === "1") {
    return "SHA-1";
  }
  if (version === "2") {
    return "SHA-256";
  }
  return undefined;
};

const decodeEnvelope = (body: string): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isJsonObject(parsed)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw unauthorized("not a signed SNS message");
};

/** Throws `Invalid` unless `opts` pins at least one topic and a usable `maxAge`. */
export const checkSnsOptions = (opts: SnsVerifyOptions): void => {
  const topics: readonly unknown[] = Array.isArray(opts.topicArn)
    ? opts.topicArn
    : [opts.topicArn];
  if (
    topics.length === 0 ||
    !topics.every((topic) => isString(topic) && topic !== "")
  ) {
    throw new FilesError(
      "Invalid",
      "files.events.webhook(): verify.sns.topicArn must name the SNS topic (or topics) your bucket publishes to"
    );
  }
  const { maxAge } = opts;
  if (
    maxAge !== undefined &&
    !(isNumber(maxAge) && Number.isFinite(maxAge) && maxAge > 0)
  ) {
    throw new FilesError(
      "Invalid",
      "files.events.webhook(): verify.sns.maxAge must be a positive number of milliseconds"
    );
  }
};

/** An upstream fetch (certificate, `SubscribeURL`) that failed: SNS should redeliver. */
const upstream = (detail: string, cause?: unknown): FilesError =>
  new FilesError("Provider", `files-sdk/events: ${detail}`, cause);

const fetchOrThrow = async (
  fetchImpl: typeof fetch,
  url: URL,
  what: string
): Promise<Response> => {
  let res: Response;
  try {
    res = await fetchImpl(url.href);
  } catch (error) {
    throw upstream(`${what} failed`, error);
  }
  if (!res.ok) {
    throw upstream(`${what} failed (${res.status})`);
  }
  return res;
};

/** Refuse a message whose signed `Timestamp` is missing, too old, or from the future. */
const checkTimestamp = (
  timestamp: JsonValue | undefined,
  at: number,
  maxAge: number
): void => {
  const sent = isString(timestamp) ? Date.parse(timestamp) : Number.NaN;
  if (Number.isNaN(sent)) {
    throw unauthorized("SNS message has no Timestamp");
  }
  if (at - sent > maxAge) {
    throw unauthorized("SNS message is too old (its Timestamp is past maxAge)");
  }
  if (sent - at > SKEW_MS) {
    throw unauthorized("SNS message Timestamp is in the future");
  }
};

/**
 * A verifier for SNS HTTP deliveries. Resolves with the verified envelope;
 * caches signing keys per certificate URL (the most recently used few).
 */
export const snsVerifier = (
  opts: SnsVerifyOptions
): ((req: Request, body: string) => Promise<JsonObject>) => {
  checkSnsOptions(opts);
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAge ?? MAX_AGE_MS;
  const topics = new Set<string>(
    isString(opts.topicArn) ? [opts.topicArn] : opts.topicArn
  );
  // Insertion-ordered, so the first key is the least recently used.
  const keys = new Map<string, Promise<CryptoKey>>();

  const fetchKey = async (
    url: URL,
    hash: "SHA-1" | "SHA-256"
  ): Promise<CryptoKey> => {
    const res = await fetchOrThrow(
      fetchImpl,
      url,
      "fetching the SNS signing certificate"
    );
    return crypto.subtle.importKey(
      "spki",
      spkiOf(pemToDer(await res.text())),
      { hash, name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"]
    );
  };

  const keyFor = (url: URL, hash: "SHA-1" | "SHA-256"): Promise<CryptoKey> => {
    const cacheKey = `${hash} ${url.href}`;
    let key = keys.get(cacheKey);
    if (key) {
      // Most recently used goes last.
      keys.delete(cacheKey);
      keys.set(cacheKey, key);
    } else {
      key = (async () => {
        try {
          return await fetchKey(url, hash);
        } catch (error) {
          // A failed fetch isn't cached: the next delivery retries it.
          // (`fetchKey` is async, so this runs after the `set` below.)
          keys.delete(cacheKey);
          throw error;
        }
      })();
      keys.set(cacheKey, key);
      const [oldest] = keys.keys();
      if (keys.size > MAX_KEYS && oldest !== undefined) {
        keys.delete(oldest);
      }
    }
    return key;
  };

  return async (req, body) => {
    if (req.headers.get("x-amz-sns-rawdelivery") === "true") {
      throw unauthorized(
        "SNS raw message delivery is unsigned; turn it off on the subscription, or authenticate another way"
      );
    }
    const message = decodeEnvelope(body);
    const { Signature, SignatureVersion, SigningCertURL, TopicArn } = message;
    const hash = hashOf(SignatureVersion);
    const certUrl = snsUrl(SigningCertURL, true);
    if (!(hash && certUrl && isString(Signature))) {
      throw unauthorized("not a signed SNS message");
    }
    // Before anything is fetched: an unauthenticated request for another
    // topic, or a stale one, costs no outbound request.
    if (!(isString(TopicArn) && topics.has(TopicArn))) {
      throw unauthorized("SNS message is from another topic");
    }
    checkTimestamp(message.Timestamp, now(), maxAge);
    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = fromBase64(Signature);
    } catch {
      throw unauthorized("SNS signature is not base64");
    }
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await keyFor(certUrl, hash),
      signature,
      utf8(stringToSign(message))
    );
    if (!valid) {
      throw unauthorized("SNS signature does not match");
    }
    return message;
  };
};

/** Answer a verified SNS subscription lifecycle message, or `undefined` for a `Notification`. */
export const snsHandshake = async (
  message: JsonObject,
  opts: SnsVerifyOptions
): Promise<Response | undefined> => {
  if (message.Type === "SubscriptionConfirmation") {
    const subscribe = snsUrl(message.SubscribeURL);
    if (!subscribe) {
      throw unauthorized("SubscribeURL is not an SNS endpoint");
    }
    if (opts.confirm) {
      await fetchOrThrow(
        opts.fetch ?? fetch,
        subscribe,
        "confirming the SNS subscription"
      );
      return Response.json({ confirmed: true });
    }
    // oxlint-disable-next-line no-console -- the only way to surface the URL a person must visit when auto-confirm is off.
    console.warn(
      `files-sdk/events: confirm the SNS subscription to ${String(message.TopicArn)} by visiting ${subscribe.href} (or pass verify: { sns: { confirm: true } })`
    );
    return Response.json({ confirmed: false });
  }
  if (message.Type === "UnsubscribeConfirmation") {
    // Never visit its SubscribeURL: that would re-subscribe.
    return Response.json({ received: 0 });
  }
  return undefined;
};
