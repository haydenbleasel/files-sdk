// The deny-by-default authorization gate. Two layers: a declarative `operations`
// allow-list (a hard gate) and the `authorize` hook (throw to deny, return a
// patch to constrain). With neither configured, only `capabilities` answers. The
// resolved `Scope` carries the key prefix, expiry clamp, disposition, content
// type override, and bulk filter the handler applies to the actual `Files` call.

import { FilesError } from "../errors.js";
import { isSingleMediaType } from "../media-type.js";
import { RouterError, markClientFacing } from "../router-core/envelope.js";
import { normalizePrefix } from "./keys.js";
import type { FilesOperation } from "./protocol.js";

export interface AuthorizeContext {
  operation: FilesOperation;
  /** The raw request — cookies, headers, and session live here. */
  req: Request;
  /** Single-key ops (client-supplied, before the authorize prefix is applied). */
  key?: string;
  /** Bulk ops. */
  keys?: string[];
  from?: string;
  to?: string;
  /** Parsed, validated op params (read-only). */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- public `authorize` callback contract (documented as `Readonly<Record<string, unknown>>`); the per-op key set varies, so a fixed interface would change the exported type's meaning
  params: Readonly<Record<string, unknown>>;
}

// oxlint-disable-next-line typescript/no-invalid-void-type -- `void` lets `authorize` be a no-return guard.
export type AuthorizeResult<TContext = unknown> = void | {
  /** Prepended to every key/from/to before the `Files` call. */
  keyPrefix?: string;
  /**
   * Hard cap, in seconds, on `url()`/`download` and upload-URL expiry (further
   * clamped by capability). The router's `defaultExpiresIn` only applies when a
   * client doesn't ask; this is the ceiling on what it may ask for.
   */
  maxExpiresIn?: number;
  /** Allow inline disposition for download/url (default forces attachment). */
  disposition?: "attachment" | "inline" | string;
  /**
   * Override the response `Content-Type` for `url` and `download` — for
   * example to preview a PDF stored as `application/octet-stream`, which a
   * browser downloads even under an `inline` disposition. Bound into the
   * signed URL where the adapter supports it
   * (`capabilities.signedUrl.contentType`); otherwise `download` proxies the
   * bytes and sets the header itself (under `downloadMode: "redirect"` it
   * fails with `Unsupported` instead), and `url` fails with `Unsupported`.
   * Like `disposition`, it describes the response, so other operations
   * ignore it: it doesn't set or restrict the type an upload stores (that's
   * the upload's `params.contentType`). Must be exactly one media type, in
   * ASCII. The client can't choose it: only this hook can, since a
   * caller-chosen `text/html` would render stored bytes as a page.
   */
  responseContentType?: string;
  /** Narrow which keys a bulk op may touch (filter, don't reject the batch). */
  filterKeys?: (key: string) => boolean;
  /** Clamp list/search page size below the router default. */
  maxResults?: number;
  /**
   * Per-request data for the gateway's lifecycle hooks — the signed-in user,
   * the tenant — handed to `onUploadComplete` as `context`, so the hook
   * doesn't re-derive the session.
   */
  context?: TContext;
};

export type Authorize<TContext = unknown> = (
  ctx: AuthorizeContext
) => AuthorizeResult<TContext> | Promise<AuthorizeResult<TContext>>;

export interface Scope {
  prefix: string;
  maxExpiresIn?: number;
  disposition?: string;
  responseContentType?: string;
  filterKeys?: (key: string) => boolean;
  maxResults?: number;
  context?: unknown;
}

export const runAuthorize = async <TContext>(
  authorize: Authorize<TContext> | undefined,
  operations: ReadonlySet<FilesOperation> | undefined,
  ctx: AuthorizeContext
): Promise<Scope> => {
  // `capabilities` is feature-flag metadata, not data — always allowed.
  if (ctx.operation !== "capabilities") {
    if (!(authorize || operations)) {
      throw new RouterError(
        "Forbidden",
        "gateway exposes no operations; configure `authorize` or `operations`",
        "forbidden"
      );
    }
    if (operations && !operations.has(ctx.operation)) {
      throw new RouterError(
        "Forbidden",
        `operation not allowed: ${ctx.operation}`,
        "forbidden"
      );
    }
  }

  let result: AuthorizeResult<TContext> | undefined;
  try {
    result = authorize ? await authorize(ctx) : undefined;
  } catch (error) {
    // A `FilesError` thrown here is the app's answer to the caller ("sign
    // in"), so its message reaches the client whatever its code.
    throw markClientFacing(error);
  }
  const patch = result ?? {};
  // It becomes a response header (proxied) or a signed override (redirected),
  // so a list, a control character, or a non-string from a plain-JS hook is
  // refused on both paths alike.
  if (
    patch.responseContentType !== undefined &&
    !isSingleMediaType(patch.responseContentType)
  ) {
    throw new FilesError(
      "Invalid",
      `authorize: responseContentType must be exactly one media type, in ASCII; got ${JSON.stringify(patch.responseContentType)}`
    );
  }
  return {
    context: patch.context,
    disposition: patch.disposition,
    filterKeys: patch.filterKeys,
    maxExpiresIn: patch.maxExpiresIn,
    maxResults: patch.maxResults,
    prefix: normalizePrefix(patch.keyPrefix),
    responseContentType: patch.responseContentType,
  };
};
