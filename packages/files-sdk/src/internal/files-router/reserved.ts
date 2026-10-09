// Plugin-private storage the gateway must never hand to a core verb. A plugin
// that keeps its own objects under a key prefix — `versioning()`'s snapshot
// store, `softDelete()`'s trash — marks that prefix on the `Files` instance, and
// the gateway refuses any client key or list prefix inside it. Without this, a
// client allowed to `delete` but not `purge` could hard-delete
// `.trash/notes.txt`, list or wipe `.versions/…`, or upload a forged version.
//
// The marker is a registry symbol per plugin (`Symbol.for`) so it survives the
// plugin and the gateway being bundled in separate passes, and a non-enumerable
// own property so it stays off the instance's public surface and types.

import type { Files } from "../../index.js";
import { isString } from "../is.js";

const RESERVED_PREFIX_KEY = "files-sdk.reservedKeyPrefix:";

/**
 * Mark `dir` — a normalized key prefix without a trailing slash — as `plugin`'s
 * private storage on `files`. Called from the plugin's `extend`, which re-runs
 * on every instance derived from it (`files.readonly()`).
 */
export const reserveKeyPrefix = (
  files: Files,
  plugin: string,
  dir: string
): void => {
  Object.defineProperty(files, Symbol.for(`${RESERVED_PREFIX_KEY}${plugin}`), {
    value: dir,
  });
};

/** Every key prefix a plugin on `files` has reserved. */
export const reservedKeyPrefixes = (files: Files): string[] =>
  Object.getOwnPropertySymbols(files).flatMap((symbol) => {
    const name = Symbol.keyFor(symbol);
    if (!name?.startsWith(RESERVED_PREFIX_KEY)) {
      return [];
    }
    const dir: unknown = Object.getOwnPropertyDescriptor(files, symbol)?.value;
    return isString(dir) && dir !== "" ? [dir] : [];
  });

/**
 * Whether `key` (or a list prefix) is a reserved dir itself or lies anywhere
 * beneath one — exactly the keys and prefixes the plugins neither hide from
 * `list()` nor treat as live objects.
 */
export const isReservedKey = (key: string, dirs: readonly string[]): boolean =>
  dirs.some((dir) => key === dir || key.startsWith(`${dir}/`));
