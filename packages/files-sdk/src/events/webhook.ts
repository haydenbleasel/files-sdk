// `files.events.webhook()` — the HTTP endpoint for providers that push. Same
// `{ handle(req) }` shape as the gateway, so every framework binding mounts
// it. Order: authenticate (the raw body, for signature schemes) → provider
// handshakes (CloudEvents `OPTIONS`, SNS subscriptions, Event Grid
// validation) → decode (exactly what was authenticated: an HMAC's raw bytes,
// an SNS envelope's signed fields) → normalize → handlers. Status codes tell
// the provider what to do next: `401` (bad credential) and `400` (malformed
// delivery) won't improve on retry; `502` (a certificate or key fetch failed)
// and `500` (a handler threw) ask for redelivery. A response names what went
// wrong only when the SDK wrote the message; anything else (a handler's error,
// which may carry your data) gets a generic one, and goes to `onError`.

import { FilesError } from "../internal/errors.js";
import type { FileEvent } from "../internal/events.js";
import type { Delivery, EventParser } from "./formats/index.js";
import type { SnsVerifyOptions } from "./sns.js";
import { snsHandshake, snsVerifier } from "./sns.js";
import type { GoogleOidcOptions } from "./verify.js";
import { googleOidcVerifier, verifyToken } from "./verify.js";

export type { SnsVerifyOptions } from "./sns.js";
export type { GoogleOidcOptions } from "./verify.js";

/** The provider's own delivery signature: B2, Cloudinary, Appwrite, Box. */
export interface SignatureVerifyOptions {
  /**
   * The signing secret: B2's `hmacSha256SigningSecret`, Cloudinary's API
   * secret, Appwrite's webhook signature key, Box's primary key.
   */
  secret: string;
  /** Box's secondary key (deliveries signed with either key pass). */
  secondarySecret?: string;
  /** Appwrite: the webhook URL exactly as configured in Appwrite (it's part of what's signed). */
  url?: string;
  /** Clock for timestamp freshness (Cloudinary, Box). Defaults to `Date.now`. */
  now?: () => number;
}

export interface EventsWebhookOptions {
  /**
   * How deliveries are authenticated. Required, so an endpoint is never
   * accidentally open:
   *
   * - `{ token }` — a shared secret, sent as `Authorization: Bearer <token>`
   *   (MinIO's webhook `auth_token`, Tigris, a Supabase webhook header) or as
   *   a `?token=` query parameter in the endpoint URL (Event Grid).
   * - `{ google }` — a Google-signed OIDC token (Pub/Sub push subscriptions
   *   with authentication, Eventarc).
   * - `{ secret }` — the provider's own signature (B2, Cloudinary, Appwrite,
   *   Box).
   * - `{ sns }` — Amazon SNS message signatures (S3 → SNS → HTTPS), pinned
   *   to your topic.
   * - `false` — something in front of this endpoint already authenticates.
   */
  verify:
    | false
    | { token: string }
    | { google: GoogleOidcOptions }
    | ({ secret: string } & SignatureVerifyOptions)
    | { sns: SnsVerifyOptions };
  /**
   * Called with a failure the response doesn't spell out: an unexpected error
   * while authenticating or parsing a delivery (answered with a generic
   * `500`). A handler's error goes to `events({ onError })` instead. Defaults
   * to `console.error`.
   */
  onError?: (cause: unknown, req: Request) => void;
}

/** A webhook endpoint: mount it with any gateway binding's `createRouteHandler`. */
export interface WebhookHandler {
  handle: (req: Request) => Promise<Response>;
}

export interface WebhookDeps {
  parser: EventParser;
  /** Decode a raw body (arrays split into one delivery per element). */
  decode: (body: string, headers: Headers) => Delivery[];
  normalize: (
    parser: EventParser,
    deliveries: readonly Delivery[]
  ) => FileEvent[];
  emit: (events: readonly FileEvent[]) => Promise<void>;
  /** Whether `emit` rejected because handlers threw (they were already reported), not for another reason. */
  isHandlerFailure: (cause: unknown) => boolean;
}

/**
 * What authenticating a delivery decided: answer it outright (an SNS
 * subscription message), or parse only the part the credential vouches for
 * (an SNS envelope's signed fields, never the unsigned rest of its body).
 * `undefined`: parse the body as received.
 */
type Authenticated = { answer: Response } | { verified: string } | undefined;

/** Checks a delivery (see {@link Authenticated}). */
type Authenticate = (
  req: Request,
  body: string
) => Promise<Authenticated> | Authenticated;

const errorResponse = (status: number, message: string): Response =>
  Response.json({ error: { message } }, { status });

const defaultOnError = (cause: unknown, req: Request): void => {
  // oxlint-disable-next-line no-console -- the default for a failure the response can't describe; override with `onError`.
  console.error(
    `files-sdk/events: webhook delivery to ${new URL(req.url).pathname} failed`,
    cause
  );
};

const misconfigured = (message: string): FilesError =>
  new FilesError("Invalid", `files.events.webhook(): ${message}`);

const authenticator = (
  verify: EventsWebhookOptions["verify"],
  parser: EventParser
): Authenticate => {
  if (verify === false) {
    return () => {
      // Something in front of the endpoint authenticates: nothing to check.
    };
  }
  if ("token" in verify) {
    if (!verify.token) {
      throw misconfigured("verify.token must be a non-empty secret");
    }
    return (req) => {
      verifyToken(req, verify.token);
    };
  }
  if ("google" in verify) {
    const check = googleOidcVerifier(verify.google);
    return async (req) => {
      await check(req);
    };
  }
  if ("sns" in verify) {
    if (parser.format !== "s3") {
      throw misconfigured(
        "verify.sns is for S3 notifications delivered by SNS"
      );
    }
    const check = snsVerifier(verify.sns);
    return async (req, body) => {
      // Only the signed fields: an unsigned `Records`, `EventSource` or `Sns`
      // riding alongside a genuine message must never reach the parser.
      const signed = await check(req, body);
      const answer = await snsHandshake(signed, verify.sns);
      return answer ? { answer } : { verified: JSON.stringify(signed) };
    };
  }
  const { verifySignature } = parser;
  if (!verifySignature) {
    throw misconfigured(
      `${parser.format} deliveries carry no signature; authenticate with verify: { token }`
    );
  }
  if (!verify.secret) {
    throw misconfigured("verify.secret must be a non-empty secret");
  }
  if (parser.format === "appwrite" && !verify.url) {
    throw misconfigured(
      "Appwrite signs the webhook URL; pass verify.url exactly as configured in Appwrite"
    );
  }
  const now = verify.now ?? Date.now;
  return async (req, body) => {
    await verifySignature({
      body,
      headers: req.headers,
      now: now(),
      secret: verify.secret,
      ...(verify.secondarySecret !== undefined && {
        secondarySecret: verify.secondarySecret,
      }),
      ...(verify.url !== undefined && { url: verify.url }),
    });
  };
};

export const createWebhook = (
  opts: EventsWebhookOptions | undefined,
  deps: WebhookDeps
): WebhookHandler => {
  if (opts?.verify === undefined) {
    throw misconfigured(
      "pass `verify` ({ token }, { google }, { secret }, { sns }, or false when something upstream authenticates)"
    );
  }
  const { parser } = deps;
  const authenticate = authenticator(opts.verify, parser);
  const onError = opts.onError ?? defaultOnError;

  // An unexpected failure: reported, and answered without its message.
  const unexpected = (cause: unknown, req: Request): Response => {
    try {
      onError(cause, req);
    } catch {
      // a throwing reporter can't change the answer
    }
    return errorResponse(500, "files-sdk/events: the delivery failed");
  };

  // Authentication failed: a bad credential (`401`), an upstream fetch for a
  // certificate, key or `SubscribeURL` that should be retried (`502`), or
  // something unexpected.
  const authFailure = (cause: unknown, req: Request): Response => {
    if (cause instanceof FilesError && cause.code === "Unauthorized") {
      return errorResponse(401, cause.message);
    }
    if (cause instanceof FilesError && cause.code === "Provider") {
      return errorResponse(502, cause.message);
    }
    return unexpected(cause, req);
  };

  // Reading the delivery failed: one the format can't read, or one a plugin
  // refuses, won't do better on a retry (`400`).
  const parseFailure = (cause: unknown, req: Request): Response =>
    cause instanceof FilesError &&
    (cause.code === "Invalid" || cause.code === "Unsupported")
      ? errorResponse(400, cause.message)
      : unexpected(cause, req);

  const handle = async (req: Request): Promise<Response> => {
    if (req.method === "HEAD") {
      // A reachability check (RustFS probes its targets before delivering).
      return new Response(null, { status: 200 });
    }
    if (req.method !== "POST" && req.method !== "OPTIONS") {
      return new Response(null, { headers: { Allow: "POST" }, status: 405 });
    }
    let body = req.method === "POST" ? await req.text() : "";
    try {
      const authenticated = await authenticate(req, body);
      if (authenticated && "answer" in authenticated) {
        return authenticated.answer;
      }
      if (authenticated) {
        body = authenticated.verified;
      }
    } catch (error) {
      return authFailure(error, req);
    }
    if (req.method === "OPTIONS") {
      return (
        parser.handshake?.(req, []) ??
        new Response(null, { headers: { Allow: "POST" }, status: 204 })
      );
    }
    let events: FileEvent[];
    try {
      const deliveries = deps.decode(body, req.headers);
      const handshake = parser.handshake?.(req, deliveries);
      if (handshake) {
        return handshake;
      }
      events = deps.normalize(parser, deliveries);
    } catch (error) {
      return parseFailure(error, req);
    }
    try {
      await deps.emit(events);
    } catch (error) {
      // Each handler's error already went to `events({ onError })`; it may
      // carry your data, so the provider only learns that one failed.
      return deps.isHandlerFailure(error)
        ? errorResponse(500, "files-sdk/events: a handler failed")
        : unexpected(error, req);
    }
    return Response.json({ received: events.length });
  };

  return { handle };
};
