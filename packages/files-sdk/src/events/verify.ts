// Authenticating webhook deliveries. Two schemes cover the Phase 2 providers:
//
// - a shared secret: MinIO's webhook `auth_token` arrives as `Authorization:
//   Bearer <token>` (or verbatim, when configured with its own scheme), and an
//   Event Grid subscription can carry one in its endpoint URL (`?token=`);
// - a Google-signed OIDC token (Pub/Sub push with authentication, Eventarc):
//   RS256, checked against Google's published JWKS, issuer, audience, expiry,
//   and the push service account.
//
// Web Crypto only, so this runs on Node, Workers, Bun and Deno alike.

import { FilesError } from "../internal/errors.js";
import { isNumber, isString } from "../internal/is.js";
import type { JsonObject } from "../internal/json.js";
import { isJsonArray, isJsonObject } from "../internal/json.js";
import { fromBase64, timingSafeEqual, utf8 } from "./crypto.js";
import { unauthorized } from "./formats/types.js";

export interface GoogleOidcOptions {
  /**
   * The audience the token must be minted for: the subscription's configured
   * audience, which Pub/Sub defaults to the push endpoint URL.
   */
  audience: string;
  /** The service account the push subscription authenticates as; checked with `email_verified`. */
  email?: string;
  /** Fetches Google's JWKS. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
/** Allowed clock drift either side of `iat` / `exp`. */
const SKEW_MS = 5 * 60 * 1000;
/** How long fetched signing keys are reused before refetching. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Accept `Authorization: Bearer <token>`, the header verbatim, or `?token=`. */
export const verifyToken = (req: Request, token: string): void => {
  const header = req.headers.get("authorization");
  const query = new URL(req.url).searchParams.get("token");
  const ok =
    (header !== null &&
      (timingSafeEqual(header, `Bearer ${token}`) ||
        timingSafeEqual(header, token))) ||
    (query !== null && timingSafeEqual(query, token));
  if (!ok) {
    throw unauthorized("delivery token missing or wrong");
  }
};

const decodeSegment = (segment: string): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64(segment))
    );
    if (isJsonObject(parsed)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw unauthorized("malformed OIDC token");
};

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const loadKeys = async (
  fetchImpl: typeof fetch
): Promise<Map<string, CryptoKey>> => {
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) {
    throw new FilesError(
      "Provider",
      `files-sdk/events: fetching Google's signing keys failed (${res.status})`
    );
  }
  const body: unknown = await res.json();
  const list = isJsonObject(body) && isJsonArray(body.keys) ? body.keys : [];
  const keys = new Map<string, CryptoKey>();
  for (const jwk of list) {
    if (isJsonObject(jwk) && isString(jwk.kid) && jwk.kty === "RSA") {
      // oxlint-disable-next-line no-await-in-loop -- Google publishes two or three keys
      const key = await crypto.subtle.importKey(
        "jwk",
        // SAFETY: an RSA JWK from Google's JWKS (`kty: "RSA"`, `n`, `e`), the
        // shape `importKey("jwk")` takes; a malformed one makes it throw.
        jwk as JsonWebKey,
        { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
        false,
        ["verify"]
      );
      keys.set(jwk.kid, key);
    }
  }
  return keys;
};

/** Check a verified token's claims: issuer, audience, expiry, and the push service account. */
const checkClaims = (
  claims: JsonObject,
  opts: GoogleOidcOptions,
  at: number
): void => {
  if (!(isString(claims.iss) && ISSUERS.has(claims.iss))) {
    throw unauthorized("OIDC token was not issued by Google");
  }
  const audiences = isJsonArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(opts.audience)) {
    throw unauthorized("OIDC token audience does not match");
  }
  if (!(isNumber(claims.exp) && claims.exp * 1000 + SKEW_MS > at)) {
    throw unauthorized("OIDC token has expired");
  }
  if (isNumber(claims.iat) && claims.iat * 1000 - SKEW_MS > at) {
    throw unauthorized("OIDC token is not valid yet");
  }
  if (
    opts.email !== undefined &&
    !(claims.email === opts.email && claims.email_verified === true)
  ) {
    throw unauthorized("OIDC token is for another service account");
  }
};

/**
 * A verifier for Google-signed OIDC tokens, caching the signing keys for an
 * hour (and refetching once for a key id it hasn't seen, when Google rotates).
 */
export const googleOidcVerifier = (
  opts: GoogleOidcOptions
): ((req: Request) => Promise<void>) => {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let cache: KeyCache | undefined;

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    const fresh = cache && now() - cache.fetchedAt < JWKS_TTL_MS;
    if (!(fresh && cache?.keys.has(kid))) {
      cache = { fetchedAt: now(), keys: await loadKeys(fetchImpl) };
    }
    return cache.keys.get(kid);
  };

  return async (req) => {
    const header = req.headers.get("authorization") ?? "";
    const token = /^Bearer\s+(?<token>\S+)$/iu.exec(header)?.groups?.token;
    if (!token) {
      throw unauthorized("missing Google OIDC bearer token");
    }
    const parts = token.split(".");
    const [head, payload, signature] = parts;
    if (!(parts.length === 3 && head && payload && signature)) {
      throw unauthorized("malformed OIDC token");
    }
    const jose = decodeSegment(head);
    if (jose.alg !== "RS256" || !isString(jose.kid)) {
      throw unauthorized("OIDC token is not RS256 with a key id");
    }
    const key = await keyFor(jose.kid);
    if (!key) {
      throw unauthorized("OIDC token signed with an unknown key");
    }
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64(signature),
      utf8(`${head}.${payload}`)
    );
    if (!valid) {
      throw unauthorized("OIDC token signature is invalid");
    }
    checkClaims(decodeSegment(payload), opts, now());
  };
};
