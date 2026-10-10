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
import { reservedKeyPrefixes } from "../internal/files-router/reserved.js";
import type {
  CompletionStore,
  OnUploadComplete,
  UploadData,
} from "../internal/files-router/upload-complete.js";
import { isFunction } from "../internal/is.js";
import {
  isReportedError,
  markClientFacing,
  toErrorResult,
} from "../internal/router-core/envelope.js";
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
export type {
  FilesOperation,
  InferUploadData,
} from "../internal/files-router/protocol.js";
export type {
  CompletionRecord,
  CompletionStore,
  OnUploadComplete,
  UploadCompleteContext,
  UploadedFileInfo,
  UploadVia,
} from "../internal/files-router/upload-complete.js";
export { UploadRejectedError } from "../internal/files-router/upload-complete.js";
export type { AllowedOrigins } from "../internal/router-core/origin.js";

export interface CreateFilesRouterOptions<TData = unknown, TContext = unknown> {
  /** A `Files` instance, or a per-request factory (multi-tenant). Pass `files.readonly()` to hard-deny writes. */
  files: Files | ((req: Request) => Files | Promise<Files>);
  /** Per-operation gate. Deny-by-default when omitted (only `capabilities` answers). */
  authorize?: Authorize<TContext>;
  /**
   * Runs once per verified upload: in `complete` for keyless uploads (after
   * the landed object's size is checked), and after a keyed `upload(key,
   * body)` stores its body. Record the upload here; the resolved value is
   * JSON-serialized back to the client as the upload result's `data`. Throw
   * to reject the upload — the object is deleted (see `onRejected`) and the
   * client gets the error; throw `UploadRejectedError` for a 422 with your
   * message.
   *
   * A client that never calls `complete` (a closed tab) never fires it; use
   * `files-sdk/events` provider notifications to reconcile those.
   */
  onUploadComplete?: OnUploadComplete<TData, TContext>;
  /**
   * What happens to an object whose upload is rejected — by
   * `onUploadComplete` throwing, or by the complete-time `maxUploadSize`
   * check. Default `"delete"`.
   */
  onRejected?: "delete" | "keep";
  /**
   * Makes keyless completions single-use: a replayed `complete` gets the
   * recorded result instead of firing `onUploadComplete` again, and the proxy
   * PUT refuses (409) further bytes for an upload that already completed.
   * Upload tokens are stateless, so without a store a client can re-`complete`
   * an upload, and re-PUT through the proxy, until its token expires — dedupe
   * on `uploadId` in the hook either way.
   */
  completions?: CompletionStore;
  /**
   * Seconds after an upload token expires during which `complete` still
   * redeems it. The token's expiry bounds when the bytes may start landing; a
   * large body can finish after it, and the client only completes once it has.
   * Default 3600.
   */
  completeGracePeriod?: number;
  /**
   * Called with every failure whose detail the client doesn't get to see, so
   * it still reaches your logs: anything thrown that isn't a `FilesError` or
   * `RouterError` (from your `authorize`/`onUploadComplete` hooks or the
   * gateway itself; the client gets a generic 500), and a storage
   * `Provider`/`Unauthorized` error, whose provider message (a filesystem
   * path, an internal hostname) the client hears only as a fixed one.
   * Default: `console.error`.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public hook contract: it receives whatever was thrown, by design
  onError?: (error: unknown, req: Request) => void;
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
  /**
   * Most keys one `search` request reads, matching or not, before it stops
   * and answers `truncated: true` — so a pattern that matches nothing can't
   * walk the whole bucket in one request. Default 10000.
   */
  maxSearchScan?: number;
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

export interface FilesApi<TData = unknown> {
  /** The framework-agnostic core every binding calls. */
  handle: (req: Request) => Promise<Response>;
  /**
   * Type-only: what `onUploadComplete` resolves to. Never set at runtime —
   * read it with {@link InferUploadData}.
   */
  readonly "~uploadData"?: TData;
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

// The per-request factory is app code: a `FilesError` it throws ("unknown
// tenant") is its answer to the client, like one `authorize` throws.
const resolveFiles = async (
  factory: (req: Request) => Files | Promise<Files>,
  req: Request
): Promise<Files> => {
  try {
    return await factory(req);
  } catch (error) {
    throw markClientFacing(error);
  }
};

export const createFilesRouter = <TData = undefined, TContext = undefined>(
  opts: CreateFilesRouterOptions<TData, TContext>
): FilesApi<TData> => {
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
    // SAFETY: `TContext` only types what `authorize` returns as `context` and
    // what `onUploadComplete` reads back; the gateway carries that value
    // through untouched (`Scope.context`), so erasing it to `unknown` here and
    // handing it to the hook unchanged preserves the caller's pairing.
    authorize: opts.authorize as Authorize | undefined,
    completeGracePeriod: opts.completeGracePeriod ?? 3600,
    completions: opts.completions,
    defaultExpiresIn: opts.defaultExpiresIn ?? 300,
    downloadMode: opts.downloadMode ?? "auto",
    forceDisposition: opts.forceDownloadDisposition ?? true,
    maxBatchSize: opts.maxBatchSize ?? 1000,
    maxConcurrency: opts.maxConcurrency ?? 16,
    maxListLimit: opts.maxListLimit ?? 1000,
    maxSearchResults: opts.maxSearchResults ?? 1000,
    maxSearchScan: opts.maxSearchScan ?? 10_000,
    maxUploadSize: opts.maxUploadSize,
    now: opts.now ?? Date.now,
    onRejected: opts.onRejected ?? "delete",
    onUnsupportedRange: opts.onUnsupportedRange ?? "reject",
    // SAFETY: see `authorize` above — the hook receives the same `context`
    // value `authorize` produced, so `TContext` holds at the call. Its result
    // only ever goes to `JSON.stringify` for the wire, which is what
    // `UploadData` models.
    onUploadComplete: opts.onUploadComplete as
      | OnUploadComplete<UploadData>
      | undefined,
    operations,
    searchPatternLimits: {
      maxLength: opts.maxSearchPatternLength ?? 256,
      maxWildcards: opts.maxSearchWildcards ?? 4,
    },
    secret,
  } satisfies Omit<
    HandlerContext,
    "files" | "req" | "proxyUrl" | "redactions" | "reportError" | "reserved"
  >;
  const maxJsonBodySize = opts.maxJsonBodySize ?? DEFAULT_MAX_JSON_BODY_SIZE;
  const onError =
    opts.onError ??
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- receives whatever was thrown
    ((error: unknown) => {
      // oxlint-disable-next-line no-console -- the default sink for errors the client only sees as a generic 500; replace it with `onError`.
      console.error("files-sdk/api: unexpected error", error);
    });

  const handle = async (req: Request): Promise<Response> => {
    const redactions = new Map<string, string>();
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- takes any thrown value
    const reportError = (error: unknown): void => {
      try {
        onError(error, req);
      } catch {
        // a throwing logger must not turn into a second failure
      }
    };
    try {
      const parsed = await parseRequest(req, maxJsonBodySize);
      const files = isFunction(opts.files)
        ? await resolveFiles(opts.files, req)
        : opts.files;
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
      const ctx: HandlerContext = {
        ...base,
        files,
        proxyUrl,
        redactions,
        reportError,
        req,
        reserved: reservedKeyPrefixes(files),
      };
      return buildResponse(await dispatch(ctx, parsed));
    } catch (error) {
      if (isReportedError(error)) {
        reportError(error);
      }
      const { body, status } = toErrorResult(error, redactions);
      return buildResponse({ body, kind: "json", status });
    }
  };

  return { handle };
};
