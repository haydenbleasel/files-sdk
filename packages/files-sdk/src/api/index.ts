// `files-sdk/api` — the server gateway. `createFilesRouter` exposes the full
// `Files` verb set over one HTTP endpoint for the browser `useFiles` hook
// (`files-sdk/react`) and the vanilla `createFilesClient` (`files-sdk/client`).
// It is framework-agnostic: `handle(req: Request) => Promise<Response>`, mounted
// via the thin framework bindings (`files-sdk/next`, `hono`, `express`,
// `fastify`, `koa`, `nestjs`, `nitro`, `sveltekit`, `astro`, `tanstack-start`)
// or called directly from any handler that has a Web `Request`.
//
// Security is deny-by-default: with no `authorize`/`operations` configured, only
// `capabilities` answers. See `authorize` for the per-operation gate.

import type { Files } from "../index.js";
import type { Authorize } from "../internal/files-router/authorize.js";
import type { HandlerContext } from "../internal/files-router/handler.js";
import { dispatch } from "../internal/files-router/handler.js";
import type { FilesOperation } from "../internal/files-router/protocol.js";
import { isFunction } from "../internal/is.js";
import { toErrorResult } from "../internal/router-core/envelope.js";
import type { AllowedOrigins } from "../internal/router-core/origin.js";
import {
  DEFAULT_MAX_JSON_BODY_SIZE,
  buildResponse,
  parseRequest,
} from "../internal/router-core/web.js";

export type {
  Authorize,
  AuthorizeContext,
  AuthorizeResult,
  Scope,
} from "../internal/files-router/authorize.js";
export type { FilesOperation } from "../internal/files-router/protocol.js";
export type { AllowedOrigins } from "../internal/router-core/origin.js";

export interface CreateFilesRouterOptions {
  /** A `Files` instance, or a per-request factory (multi-tenant). Pass `files.readonly()` to hard-deny writes. */
  files: Files | ((req: Request) => Files | Promise<Files>);
  /** Per-operation gate. Deny-by-default when omitted (only `capabilities` answers). */
  authorize?: Authorize;
  /** Declarative allow-list: operations permitted without a hook. A hard gate that runs before `authorize`. */
  operations?: readonly FilesOperation[];
  /** CSRF/origin allowlist for state-changing actions. Defaults to same-origin when omitted. */
  allowedOrigins?: AllowedOrigins;
  /**
   * Expiry, in seconds, for `url()`/`download` redirects and upload presigns when
   * the client doesn't ask for one. Default 300. Not a ceiling — a client may
   * request a longer `expiresIn`; cap it with `authorize`'s `maxExpiresIn`
   * (every value is also clamped to the adapter's signing limit).
   */
  defaultExpiresIn?: number;
  /** Force `Content-Disposition: attachment` on the proxy-download path unless `authorize` opts inline. Default true. */
  forceDownloadDisposition?: boolean;
  /** Cap on a `list` page (and on the page size a `search` walks with). Default 1000. */
  maxListLimit?: number;
  /** Cap on `search` results returned in one page. Default 1000. */
  maxSearchResults?: number;
  /** Reject uploads larger than this (bytes) — bound into the presigned policy + verified on complete. */
  maxUploadSize?: number;
  /** Cap on the `keys[]`/`files[]`/`completions[]` of one bulk request; larger ones get 413 (reason `count`). Default 1000. */
  maxBatchSize?: number;
  /** Ceiling on the `concurrency` a client requests for a bulk op. Default 16. */
  maxConcurrency?: number;
  /** Cap on a JSON (POST) request body, bytes; larger ones get 413. Default 1 MiB. */
  maxJsonBodySize?: number;
  /** Longest accepted `search` pattern, characters. Default 256 (422 beyond it). */
  maxSearchPatternLength?: number;
  /**
   * Most unbounded wildcards/quantifiers (`*`, `**`, `+`, `{n,}`; an unanchored
   * regex counts one extra) a `search` pattern may carry. Each one multiplies
   * the backtracking work per key, so this bounds a client-supplied pattern's
   * CPU cost. Nested repetition (`(a+)+`) is always refused. Default 4.
   */
  maxSearchWildcards?: number;
  /** `download` strategy. Default `"auto"` (redirect when the adapter can sign, else proxy). */
  downloadMode?: "auto" | "redirect" | "proxy";
  /** A `Range` request on a non-range adapter. Default `"reject"` (416). */
  onUnsupportedRange?: "reject" | "ignore";
  /** HMAC secret for the upload round-trip tokens. Falls back to `FILES_API_SECRET`, then a per-process random (warns). */
  secret?: string;
  /** Clock injection point for token expiry; defaults to `Date.now`. */
  now?: () => number;
}

export interface FilesApi {
  /** The framework-agnostic core every binding calls. */
  handle: (req: Request) => Promise<Response>;
}

const resolveSecret = (secret: string | undefined): string => {
  if (secret) {
    return secret;
  }
  const env =
    typeof process === "undefined" ? undefined : process.env?.FILES_API_SECRET;
  if (env) {
    return env;
  }
  // oxlint-disable-next-line no-console -- a single construction-time warning.
  console.warn(
    "files-sdk/api: no `secret` and no FILES_API_SECRET — using a per-process random fallback. Uploads will not verify across load-balanced instances. Set a stable secret in production."
  );
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
};

export const createFilesRouter = (opts: CreateFilesRouterOptions): FilesApi => {
  if (!(opts.authorize || opts.operations)) {
    // oxlint-disable-next-line no-console -- construction-time safety warning.
    console.warn(
      "files-sdk/api: gateway exposes no operations — set `authorize` or `operations`. Only `capabilities` will answer."
    );
  }

  const secret = resolveSecret(opts.secret);
  const operations = opts.operations ? new Set(opts.operations) : undefined;
  const base = {
    allowedOrigins: opts.allowedOrigins,
    authorize: opts.authorize,
    defaultExpiresIn: opts.defaultExpiresIn ?? 300,
    downloadMode: opts.downloadMode ?? "auto",
    forceDisposition: opts.forceDownloadDisposition ?? true,
    maxBatchSize: opts.maxBatchSize ?? 1000,
    maxConcurrency: opts.maxConcurrency ?? 16,
    maxListLimit: opts.maxListLimit ?? 1000,
    maxSearchResults: opts.maxSearchResults ?? 1000,
    maxUploadSize: opts.maxUploadSize,
    now: opts.now ?? Date.now,
    onUnsupportedRange: opts.onUnsupportedRange ?? "reject",
    operations,
    searchPatternLimits: {
      maxLength: opts.maxSearchPatternLength ?? 256,
      maxWildcards: opts.maxSearchWildcards ?? 4,
    },
    secret,
  } satisfies Omit<HandlerContext, "files" | "req" | "proxyUrl">;
  const maxJsonBodySize = opts.maxJsonBodySize ?? DEFAULT_MAX_JSON_BODY_SIZE;

  const handle = async (req: Request): Promise<Response> => {
    try {
      const parsed = await parseRequest(req, maxJsonBodySize);
      const files = isFunction(opts.files) ? await opts.files(req) : opts.files;
      const proxyUrl = (token: string): string => {
        const url = new URL(req.url);
        // Keep the caller's own query (e.g. a `?bucket=` hint consumed by a
        // per-request `files` factory) so the proxy round-trip resolves the
        // same instance; only the routing params are replaced.
        url.searchParams.delete("key");
        url.searchParams.set("op", "proxy");
        url.searchParams.set("token", token);
        return url.toString();
      };
      const ctx: HandlerContext = { ...base, files, proxyUrl, req };
      return buildResponse(await dispatch(ctx, parsed));
    } catch (error) {
      const { body, status } = toErrorResult(error);
      return buildResponse({ body, kind: "json", status });
    }
  };

  return { handle };
};
