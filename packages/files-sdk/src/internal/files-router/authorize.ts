// The deny-by-default authorization gate. Two layers: a declarative `operations`
// allow-list (a hard gate) and the `authorize` hook (throw to deny, return a
// patch to constrain). With neither configured, only `capabilities` answers. The
// resolved `Scope` carries the key prefix, expiry clamp, disposition, and bulk
// filter the handler applies to the actual `Files` call.

import { RouterError } from "../router-core/envelope.js";
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

  const patch = (authorize ? await authorize(ctx) : undefined) ?? {};
  return {
    context: patch.context,
    disposition: patch.disposition,
    filterKeys: patch.filterKeys,
    maxExpiresIn: patch.maxExpiresIn,
    maxResults: patch.maxResults,
    prefix: normalizePrefix(patch.keyPrefix),
  };
};
