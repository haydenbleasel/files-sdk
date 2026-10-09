// Amazon SNS over HTTP(S) — S3 → SNS → your endpoint. SNS signs every message
// with an RSA key whose certificate is published at `SigningCertURL`: the
// string to sign is a fixed list of `Key\nValue\n` fields, verified with
// RSASSA-PKCS1-v1_5 over SHA-1 (`SignatureVersion` 1) or SHA-256 (2). The
// certificate is trusted because of where it comes from — an SNS host, over
// HTTPS — so that URL (and a `SubscribeURL` before visiting it) must be an
// SNS endpoint. Raw message delivery strips the signature, so it fails closed.

import { isString } from "../internal/is.js";
import type { JsonObject, JsonValue } from "../internal/json.js";
import { isJsonObject } from "../internal/json.js";
import { fromBase64, utf8 } from "./crypto.js";
import { unauthorized } from "./formats/types.js";
import { pemToDer, spkiOf } from "./x509.js";

export interface SnsVerifyOptions {
  /** Only accept messages from this topic (recommended). */
  topicArn?: string;
  /**
   * Visit the `SubscribeURL` of a verified `SubscriptionConfirmation`, so a
   * new subscription starts delivering. Default `false`: the URL is logged
   * for you to confirm by hand (SNS sends nothing until you do).
   */
  confirm?: boolean;
  /** Fetches the signing certificate and the `SubscribeURL`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const SNS_HOST = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(?:\.cn)?$/u;

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

/** An `https://sns.<region>.amazonaws.com[.cn]/…` URL, or `undefined`. */
export const snsUrl = (
  value: JsonValue | undefined,
  pem = false
): URL | undefined => {
  if (!isString(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      SNS_HOST.test(url.hostname) &&
      (!pem || url.pathname.endsWith(".pem"))
      ? url
      : undefined;
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

/**
 * A verifier for SNS HTTP deliveries. Resolves with the verified envelope;
 * caches signing keys per certificate URL.
 */
export const snsVerifier = (
  opts: SnsVerifyOptions
): ((req: Request, body: string) => Promise<JsonObject>) => {
  const fetchImpl = opts.fetch ?? fetch;
  const keys = new Map<string, Promise<CryptoKey>>();

  const fetchKey = async (
    url: URL,
    hash: "SHA-1" | "SHA-256"
  ): Promise<CryptoKey> => {
    const res = await fetchImpl(url.href);
    if (!res.ok) {
      throw unauthorized(
        `fetching the SNS signing certificate failed (${res.status})`
      );
    }
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
    if (!key) {
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
    if (opts.topicArn !== undefined && TopicArn !== opts.topicArn) {
      throw unauthorized("SNS message is from another topic");
    }
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
      const res = await (opts.fetch ?? fetch)(subscribe.href);
      if (!res.ok) {
        return Response.json(
          {
            error: {
              message: `confirming the subscription failed (${res.status})`,
            },
          },
          { status: 502 }
        );
      }
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
