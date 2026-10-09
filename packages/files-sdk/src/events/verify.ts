// Authenticating webhook deliveries. Two schemes cover the Phase 2 providers:
//
// - a shared secret: MinIO's webhook `auth_token` arrives as `Authorization:
//   Bearer <token>` (or verbatim, when configured with its own scheme), and an
//   Event Grid subscription can carry one in its endpoint URL (`?token=`);
// - a Google-signed OIDC token (Pub/Sub push with authentication, Eventarc):
//   RS256, checked against Google's published JWKS, issuer, audience, expiry,
//   and the push service account. The account is required: any Google
//   account can mint a Google-signed token for any audience, so the audience
//   alone proves nothing about who sent it.
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
  /**
   * The service account the push subscription authenticates as, checked with
   * `email_verified`. Required: anyone can mint a Google-signed token for any
   * audience, so only the account says the push came from your subscription.
   */
  email: string;
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
/**
 * The least time between two fetches of Google's keys, however many tokens
 * name a key id they don't have. Google publishes a new key well before it
 * signs with it, so a real rotation is picked up; a flood of made-up key ids
 * costs one fetch a minute.
 */
const REFETCH_AFTER_MS = 60 * 1000;

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
  let res: Response;
  try {
    res = await fetchImpl(JWKS_URL);
  } catch (error) {
    throw new FilesError(
      "Provider",
      "files-sdk/events: fetching Google's signing keys failed",
      error
    );
  }
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
  if (!(claims.email === opts.email && claims.email_verified === true)) {
    throw unauthorized("OIDC token is for another service account");
  }
};

/** Throws `Invalid` unless `opts` names both an audience and a service account. */
export const checkGoogleOptions = (opts: GoogleOidcOptions): void => {
  if (!(isString(opts.audience) && opts.audience !== "")) {
    throw new FilesError(
      "Invalid",
      "files.events.webhook(): verify.google.audience must be the push subscription's audience (by default, the endpoint URL)"
    );
  }
  if (!(isString(opts.email) && opts.email !== "")) {
    throw new FilesError(
      "Invalid",
      "files.events.webhook(): verify.google.email must be the service account the push subscription authenticates as"
    );
  }
};

/**
 * A verifier for Google-signed OIDC tokens, caching the signing keys for an
 * hour. A key id it hasn't seen refetches them (Google rotates), at most once
 * a minute; concurrent requests share one fetch.
 */
export const googleOidcVerifier = (
  opts: GoogleOidcOptions
): ((req: Request) => Promise<void>) => {
  checkGoogleOptions(opts);
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let cache: KeyCache | undefined;
  let loading: Promise<KeyCache> | undefined;

  const reload = (): Promise<KeyCache> => {
    loading ??= (async () => {
      try {
        const keys = await loadKeys(fetchImpl);
        cache = { fetchedAt: now(), keys };
        return cache;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  };

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    const age = cache ? now() - cache.fetchedAt : Number.POSITIVE_INFINITY;
    if (
      cache &&
      age < JWKS_TTL_MS &&
      (cache.keys.has(kid) || age < REFETCH_AFTER_MS)
    ) {
      return cache.keys.get(kid);
    }
    const loaded = await reload();
    return loaded.keys.get(kid);
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
