import { handlers } from "../index.js";
import type { Body, FilesPlugin } from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";

/**
 * A key-naming rule for {@link validation}. Either a {@link RegExp} the key must
 * match (anchor it yourself, e.g. `/^[\w.-]+$/`; don't use the `g` flag) or a
 * predicate that returns `true` for keys you allow.
 */
export type KeyRule = RegExp | ((key: string) => boolean);

export interface ValidationOptions {
  /** Reject uploads larger than this many bytes. */
  maxSize?: number;
  /** Reject uploads smaller than this many bytes — e.g. `1` to refuse empties. */
  minSize?: number;
  /**
   * Allowed MIME types. Each entry is an exact type (`"image/png"`) or a group
   * wildcard (`"image/*"`). Matching is case-insensitive and ignores any
   * `; charset=…` parameter. The type checked is `options.contentType` when you
   * pass it, else a `Blob`/`File`'s own `.type`, else the type inferred from the
   * key's extension.
   */
  allowedTypes?: string[];
  /**
   * Constrain the key — a {@link RegExp} it must match, or a predicate that
   * returns `true` for allowed keys. Enforced on `upload` and on the
   * destination of `copy` / `move`.
   */
  key?: KeyRule;
}

/** Strip any `; charset=…` parameter and normalize for comparison. */
const baseType = (value: string): string => {
  const semicolon = value.indexOf(";");
  const essence = semicolon === -1 ? value : value.slice(0, semicolon);
  return essence.trim().toLowerCase();
};

/** Whether `type` satisfies any of `allowed` (an exact match or `group/*`). */
const typeIsAllowed = (type: string, allowed: readonly string[]): boolean => {
  const actual = baseType(type);
  const slash = actual.indexOf("/");
  const group = slash === -1 ? "" : actual.slice(0, slash + 1);
  return allowed.some((entry) => {
    const pattern = baseType(entry);
    return (
      pattern === actual ||
      (pattern.endsWith("/*") && pattern.slice(0, -1) === group)
    );
  });
};

/**
 * The MIME type an upload will be stored as, for the `allowedTypes` check:
 * an explicit `contentType` wins, then a `Blob`/`File`'s own type, then the
 * type inferred from the key's extension (the SDK's own fallback).
 */
const resolveUploadType = (
  contentType: string | undefined,
  body: Body,
  key: string
): string => {
  if (contentType !== undefined) {
    return contentType;
  }
  if (body instanceof Blob && body.type) {
    return body.type;
  }
  return inferTypeFromName(key);
};

/**
 * A fail-closed guard that vets writes **before they happen** — a max/min size,
 * an allowed-MIME-type list, and a key-naming rule. It rejects a bad `upload`
 * (and a `copy` / `move` to a disallowed key) by throwing, so no bytes ever
 * reach the adapter.
 *
 * Unlike `compression()` / `encryption()`, it never transforms the body or
 * writes metadata, so **reads, `url()`, `copy`, and `move` pass straight
 * through** — there's nothing to undo. The size check is the one exception that
 * has to see the bytes: for an unknown-length stream it buffers the body to
 * measure it (the same trade-off the buffering plugins make), so reach for it
 * before streaming-only setups. Key and type rules never touch the body.
 *
 * Place it **first** in the array so it vets the caller's original key and bytes
 * before anything downstream transforms them:
 * `plugins: [validation({ maxSize }), compression(), encryption(key)]`.
 *
 * `signedUploadUrl()` hands upload capability to a client that writes directly,
 * bypassing the plugin — so when a size or type rule is set it **fails closed**
 * (a key-only policy still mints the URL, after checking the key).
 *
 * @param options `maxSize`, `minSize`, `allowedTypes`, and/or `key` — any
 *   combination; with none set the plugin is a no-op pass-through.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { validation } from "files-sdk/validation";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [
 *     validation({
 *       maxSize: 10 * 1024 * 1024, // 10 MiB
 *       allowedTypes: ["image/*", "application/pdf"],
 *       key: /^[\w.-]+$/,
 *     }),
 *   ],
 * });
 *
 * await files.upload("photo.png", bytes); // ok
 * await files.upload("notes.txt", "…"); // throws: type not allowed
 * ```
 */
export const validation = (options: ValidationOptions = {}): FilesPlugin => {
  const { allowedTypes, key: keyRule, maxSize, minSize } = options;
  const hasBodyRule =
    allowedTypes !== undefined ||
    maxSize !== undefined ||
    minSize !== undefined;

  const assertKey = (value: string): void => {
    if (keyRule === undefined) {
      return;
    }
    const ok =
      typeof keyRule === "function" ? keyRule(value) : keyRule.test(value);
    if (!ok) {
      throw new FilesError(
        "Provider",
        `validation: key "${value}" is not allowed`
      );
    }
  };

  const assertSize = (size: number, key: string): void => {
    if (maxSize !== undefined && size > maxSize) {
      throw new FilesError(
        "Provider",
        `validation: "${key}" is ${size} bytes, over the ${maxSize}-byte limit`
      );
    }
    if (minSize !== undefined && size < minSize) {
      throw new FilesError(
        "Provider",
        `validation: "${key}" is ${size} bytes, under the ${minSize}-byte minimum`
      );
    }
  };

  return {
    name: "validation",
    wrap: handlers({
      copy: (op, next) => {
        assertKey(op.to);
        return next(op);
      },
      move: (op, next) => {
        assertKey(op.to);
        return next(op);
      },
      signedUploadUrl: (op, next) => {
        assertKey(op.key);
        if (hasBodyRule) {
          throw new FilesError(
            "Provider",
            "validation: signedUploadUrl() bypasses size and type checks (the client uploads directly, never through the plugin); upload through the Files instance to enforce them"
          );
        }
        return next(op);
      },
      upload: async (op, next) => {
        assertKey(op.key);
        if (allowedTypes !== undefined) {
          const type = resolveUploadType(
            op.options?.contentType,
            op.body,
            op.key
          );
          if (!typeIsAllowed(type, allowedTypes)) {
            throw new FilesError(
              "Provider",
              `validation: "${op.key}" has type "${baseType(type)}", which is not one of the allowed types (${allowedTypes.join(", ")})`
            );
          }
        }
        // No size rule → nothing left to inspect; forward the body untouched
        // so streaming and resumable uploads keep working.
        if (maxSize === undefined && minSize === undefined) {
          return next(op);
        }
        // A size rule needs the byte count. Buffer an unknown-length stream to
        // measure it, then forward the buffer so the check stays outside the
        // retry loop and a retry replays the same bytes.
        const normalized = await normalizeBody(
          op.body,
          op.options?.contentType
        );
        const bytes =
          normalized.data instanceof Uint8Array
            ? normalized.data
            : await collectStream(normalized.data);
        assertSize(bytes.byteLength, op.key);
        return next({
          ...op,
          body: bytes,
          options: { ...op.options, contentType: normalized.contentType },
        });
      },
    }),
  };
};
