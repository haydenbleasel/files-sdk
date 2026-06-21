// Key safety + the authorize-prefix scoping the gateway applies before every
// `Files` call. Client-supplied keys are always prepended with the authorize
// `keyPrefix` (so a client literally cannot address outside its scope) and then
// validated — a `..`/`.` segment, NUL byte, leading slash, or empty key is
// rejected, which also catches an attempt to climb out of the prefix.

import { RouterError } from "../router-core/envelope.js";

const RELATIVE_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)/u;

export const assertSafeKey = (key: string): void => {
  if (
    key === "" ||
    key.includes("\0") ||
    key.startsWith("/") ||
    RELATIVE_SEGMENT.test(key)
  ) {
    throw new RouterError("Validation", `unsafe key: ${key}`, "key");
  }
};

/** Like {@link assertSafeKey} but permits the empty string (a list-everything prefix). */
export const assertSafePrefix = (prefix: string): void => {
  if (
    prefix.includes("\0") ||
    prefix.startsWith("/") ||
    RELATIVE_SEGMENT.test(prefix)
  ) {
    throw new RouterError("Validation", `unsafe prefix: ${prefix}`, "key");
  }
};

/** Normalize a client-facing prefix to `""` or `"trimmed/"`. */
export const normalizePrefix = (prefix?: string): string => {
  if (!prefix) {
    return "";
  }
  const trimmed = prefix.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed === "" ? "" : `${trimmed}/`;
};

/** Prepend the authorize prefix and validate the resolved key. */
export const scopeKey = (prefix: string, key: string): string => {
  const scoped = prefix + key;
  assertSafeKey(scoped);
  return scoped;
};

/** Strip the authorize prefix from a storage-relative key for the wire. */
export const unscopeKey = (prefix: string, key: string): string =>
  prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
