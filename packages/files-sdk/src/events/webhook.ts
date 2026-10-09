// `files.events.webhook()` — the HTTP endpoint for providers that push. Same
// `{ handle(req) }` shape as the gateway, so every framework binding mounts
// it. Order: authenticate (the raw body, for signature schemes) → provider
// handshakes (CloudEvents `OPTIONS`, SNS subscriptions, Event Grid
// validation) → decode → normalize → handlers. Status codes tell the provider
// what to do next: `401` (bad credential) and `400` (malformed delivery)
// won't improve on retry; `500` (a handler threw) asks for redelivery.

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
   * - `{ sns }` — Amazon SNS message signatures (S3 → SNS → HTTPS).
   * - `false` — something in front of this endpoint already authenticates.
   */
  verify:
    | false
    | { token: string }
    | { google: GoogleOidcOptions }
    | ({ secret: string } & SignatureVerifyOptions)
    | { sns: SnsVerifyOptions };
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
}

/** Checks a delivery; may answer it outright (an SNS subscription message). */
type Authenticate = (
  req: Request,
  body: string
) => Promise<Response | undefined> | Response | undefined;

const errorResponse = (status: number, message: string): Response =>
  Response.json({ error: { message } }, { status });

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
    return async (req, body) =>
      snsHandshake(await check(req, body), verify.sns);
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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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

  const handle = async (req: Request): Promise<Response> => {
    if (req.method === "HEAD") {
      // A reachability check (RustFS probes its targets before delivering).
      return new Response(null, { status: 200 });
    }
    if (req.method !== "POST" && req.method !== "OPTIONS") {
      return new Response(null, { headers: { Allow: "POST" }, status: 405 });
    }
    const body = req.method === "POST" ? await req.text() : "";
    try {
      const answered = await authenticate(req, body);
      if (answered) {
        return answered;
      }
    } catch (error) {
      return error instanceof FilesError && error.code === "Unauthorized"
        ? errorResponse(401, error.message)
        : errorResponse(500, messageOf(error));
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
      return errorResponse(400, messageOf(error));
    }
    try {
      await deps.emit(events);
    } catch (error) {
      return errorResponse(500, messageOf(error));
    }
    return Response.json({ received: events.length });
  };

  return { handle };
};
