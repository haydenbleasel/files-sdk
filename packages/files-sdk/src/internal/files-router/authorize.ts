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
  params: Readonly<Record<string, unknown>>;
}

// oxlint-disable-next-line typescript/no-invalid-void-type -- `void` lets `authorize` be a no-return guard.
export type AuthorizeResult = void | {
  /** Prepended to every key/from/to before the `Files` call. */
  keyPrefix?: string;
  /** Hard cap on `url()`/`download` expiry (further clamped by capability). */
  maxExpiresIn?: number;
  /** Allow inline disposition for download/url (default forces attachment). */
  disposition?: "attachment" | "inline" | string;
  /** Narrow which keys a bulk op may touch (filter, don't reject the batch). */
  filterKeys?: (key: string) => boolean;
  /** Clamp list/search page size below the router default. */
  maxResults?: number;
};

export type Authorize = (
  ctx: AuthorizeContext
) => AuthorizeResult | Promise<AuthorizeResult>;

export interface Scope {
  prefix: string;
  maxExpiresIn?: number;
  disposition?: string;
  filterKeys?: (key: string) => boolean;
  maxResults?: number;
}

export const runAuthorize = async (
  authorize: Authorize | undefined,
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
    disposition: patch.disposition,
    filterKeys: patch.filterKeys,
    maxExpiresIn: patch.maxExpiresIn,
    maxResults: patch.maxResults,
    prefix: normalizePrefix(patch.keyPrefix),
  };
};
