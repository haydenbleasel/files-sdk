// Key safety + the authorize-prefix scoping the gateway applies before every
// `Files` call. Client-supplied keys are always prepended with the authorize
// `keyPrefix` (so a client literally cannot address outside its scope) and then
// validated — a `..`/`.` segment, NUL byte, leading slash, or empty key is
// rejected, which also catches an attempt to climb out of the prefix. A
// backslash counts as a separator for the `.`/`..` check: the `fs` adapter on
// Windows resolves `..\u2\secret.txt` as a climb into a sibling tenant.

import { RouterError } from "../router-core/envelope.js";
import { isReservedKey } from "./reserved.js";

const RELATIVE_SEGMENT = /(?:^|[/\\])\.\.?(?:[/\\]|$)/u;

const isUnsafePath = (value: string): boolean =>
  value.includes("\0") ||
  value.startsWith("/") ||
  value.startsWith("\\") ||
  RELATIVE_SEGMENT.test(value);

/** Refuse an unsafe list/search prefix (the empty string lists everything). */
export const assertSafePrefix = (prefix: string): void => {
  if (isUnsafePath(prefix)) {
    throw new RouterError("Validation", `unsafe prefix: ${prefix}`, "key");
  }
};

/** The refusal for a key or prefix inside a plugin's reserved storage. */
export const outsideScope = (): RouterError =>
  new RouterError("Forbidden", "key is outside authorized scope", "forbidden");

/** Normalize a client-facing prefix to `""` or `"trimmed/"`. */
export const normalizePrefix = (prefix?: string): string => {
  if (!prefix) {
    return "";
  }
  const trimmed = prefix.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed === "" ? "" : `${trimmed}/`;
};

/**
 * Prepend the authorize prefix and validate the resolved key: unsafe → 422,
 * inside a plugin's `reserved` storage → 403. The messages name the key the
 * client sent, never the resolved storage key.
 */
export const scopeKey = (
  prefix: string,
  key: string,
  reserved: readonly string[] = []
): string => {
  const scoped = prefix + key;
  if (scoped === "" || isUnsafePath(scoped)) {
    throw new RouterError("Validation", `unsafe key: ${key}`, "key");
  }
  if (isReservedKey(scoped, reserved)) {
    throw outsideScope();
  }
  return scoped;
};

/** Strip the authorize prefix from a storage-relative key for the wire. */
export const unscopeKey = (prefix: string, key: string): string =>
  prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
