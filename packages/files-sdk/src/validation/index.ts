import { handlers } from "../index.js";
import type { Body, FilesPlugin } from "../index.js";
import { collectStream } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { isFunction, isString } from "../internal/is.js";
import { mediaTypeEssence } from "../internal/media-type.js";
import { inferTypeFromName } from "../internal/mime.js";

/**
 * A key-naming rule for {@link validation}. Either a {@link RegExp} the key must
 * match (anchor it yourself, e.g. `/^[\w.-]+$/`; don't use the `g` flag) or a
 * predicate that returns `true` for keys you allow.
 */
export type KeyRule = RegExp | ((key: string) => boolean);

/**
 * Which rule a {@link ValidationError} failed: the `key` naming rule, the
 * `size` bounds (`maxSize` / `minSize` — the message says which), or the
 * `allowedTypes` list (`type`).
 */
export type ValidationReason = "key" | "size" | "type";

/**
 * Thrown by {@link validation} when a write fails one of its rules. A regular
 * {@link FilesError} (`code: "Invalid"`) with a {@link ValidationReason}
 * discriminant, so callers can branch on *which* rule failed without parsing
 * the message:
 *
 * ```ts
 * try {
 *   await files.upload(key, body);
 * } catch (e) {
 *   if (e instanceof ValidationError && e.reason === "type") {
 *     // reject with "unsupported file type"
 *   }
 * }
 * ```
 *
 * Note the `signedUploadUrl()` fail-closed throw is **not** a
 * `ValidationError` — that's the plugin refusing an unenforceable operation,
 * not the file failing a rule (it has `code: "Unsupported"`).
 */
export class ValidationError extends FilesError {
  readonly reason: ValidationReason;

  constructor(reason: ValidationReason, message: string) {
    // Permanent: the same write can only fail the same rule again, so it's
    // never retried — or re-sent by `failover()` to a backend that skips it.
    super("Invalid", message);
    this.name = "ValidationError";
    this.reason = reason;
  }
}

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
   * key's extension — and that checked type is forwarded as the upload's
   * `contentType`, so it's the type that gets stored. A type that isn't exactly
   * one well-formed media type (`"image/png, text/html"`, a missing subtype, a
   * control character) is rejected outright: a browser reads a
   * comma-separated list as its *last* entry, so it would render a type the
   * check never saw.
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

/**
 * Whether the media-type `essence` (already lowercased `type/subtype`)
 * satisfies any of `allowed` (an exact match or `group/*`).
 */
const typeIsAllowed = (
  essence: string,
  allowed: readonly string[]
): boolean => {
  const group = essence.slice(0, essence.indexOf("/") + 1);
  return allowed.some((entry) => {
    const pattern = baseType(entry);
    return (
      pattern === essence ||
      (pattern.endsWith("/*") && pattern.slice(0, -1) === group)
    );
  });
};

/**
 * The approved type as it's stored: the normalized essence plus whatever
 * parameters the caller attached (`text/plain; charset=utf-8`). Only called
 * once {@link mediaTypeEssence} has accepted `type`, so the parameters hold no
 * comma or control character.
 */
const storedType = (type: string, essence: string): string => {
  const semicolon = type.indexOf(";");
  return semicolon === -1 ? essence : `${essence}${type.slice(semicolon)}`;
};

/**
 * The MIME type an upload is checked (and then stored) as, for the
 * `allowedTypes` check: an explicit `contentType` wins, then a `Blob`/`File`'s
 * own type, then the type inferred from the key's extension. The SDK core
 * never infers from the key, so the plugin forwards this type explicitly.
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

/** Code points past which UTF-8 needs 2, 3, and 4 bytes. */
const UTF8_TWO_BYTES = 0x80;
const UTF8_THREE_BYTES = 0x8_00;
const UTF8_FOUR_BYTES = 0x1_00_00;

/**
 * The UTF-8 byte length of `value` — what `TextEncoder` would produce, a lone
 * surrogate included (it encodes as the 3-byte U+FFFD) — without allocating
 * the encoded copy.
 */
const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    // SAFETY: `i < value.length`, so there's a code point at `i`.
    const code = value.codePointAt(i) as number;
    if (code < UTF8_TWO_BYTES) {
      bytes += 1;
    } else if (code < UTF8_THREE_BYTES) {
      bytes += 2;
    } else if (code < UTF8_FOUR_BYTES) {
      bytes += 3;
    } else {
      // A surrogate pair: one code point, two code units.
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
};

/**
 * An upload body's byte count. Known-length shapes are measured in place —
 * nothing is read or copied, so a multi-gigabyte `File` over `maxSize` is
 * rejected without being loaded. Only an unknown-length stream (or a `Blob`
 * that can't report a finite size) is drained, and its bytes are returned as
 * `buffered` for the caller to forward in place of the spent original.
 */
const measure = async (
  body: Body
): Promise<{ size: number; buffered?: Uint8Array }> => {
  if (isString(body)) {
    return { size: utf8ByteLength(body) };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return { size: body.byteLength };
  }
  if (body instanceof Blob && Number.isFinite(body.size)) {
    return { size: body.size };
  }
  const buffered = await collectStream(
    body instanceof Blob ? body.stream() : body
  );
  return { buffered, size: buffered.byteLength };
};

/**
 * A fail-closed guard that vets writes **before they happen** — a max/min size,
 * an allowed-MIME-type list, and a key-naming rule. It rejects a bad `upload`
 * (and a `copy` / `move` to a disallowed key) by throwing a
 * {@link ValidationError} — its `reason` says which rule failed — so no bytes
 * ever reach the adapter.
 *
 * Unlike `compression()` / `encryption()`, it never transforms the body or
 * writes metadata, so **reads and `url()` pass straight through** — there's
 * nothing to undo — and `copy` / `move` only have their destination key
 * checked. The size check is the one rule that has to see the bytes:
 * known-length bodies (strings, byte arrays, `Blob`s and `File`s) are measured
 * without being read, but an unknown-length stream is buffered to measure it
 * (the same trade-off the buffering plugins make), so reach for it before
 * streaming-only setups. Key and type rules never touch the body. With
 * `allowedTypes` set, the checked type is forwarded as the upload's
 * `contentType`, so the object is stored as the type that was approved.
 *
 * Plugins run in array order (`plugins[0]` is outermost), so placement matters:
 * - Put it **before** `versioning()`, `softDelete()`, `dedup()`, and any
 *   body-transforming plugin, so it vets the caller's original key and bytes.
 *   Those plugins' own housekeeping writes (`.versions/…`, `.trash/…`,
 *   `.dedup/…`, and dedup's empty pointer bodies) only pass through the
 *   plugins after them — so a `key` or `minSize` rule placed after them would
 *   reject their internal writes and break every overwrite, delete, or upload.
 * - Put `contentType()` **before** it. `validation()` checks the type the
 *   client *claims*; a `contentType()` placed after it can still relabel the
 *   approved upload from its bytes (a `.png` that's really HTML becomes
 *   `text/html`), slipping past `allowedTypes`. With `contentType()` first,
 *   `validation()` checks the corrected type.
 *
 * `plugins: [contentType(), validation({ maxSize, allowedTypes }), versioning(),
 * compression(), encryption(key)]`.
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
    const ok = isFunction(keyRule) ? keyRule(value) : keyRule.test(value);
    if (!ok) {
      throw new ValidationError(
        "key",
        `validation: key "${value}" is not allowed`
      );
    }
  };

  const assertSize = (size: number, key: string): void => {
    if (maxSize !== undefined && size > maxSize) {
      throw new ValidationError(
        "size",
        `validation: "${key}" is ${size} bytes, over the ${maxSize}-byte limit`
      );
    }
    if (minSize !== undefined && size < minSize) {
      throw new ValidationError(
        "size",
        `validation: "${key}" is ${size} bytes, under the ${minSize}-byte minimum`
      );
    }
  };

  return {
    // With a size or type rule, `signedUploadUrl()` is refused (a direct
    // upload skips those checks), so advertise that; the `files-sdk/api`
    // gateway then proxies uploads through the instance instead of presigning.
    // Key rules alone still let it through.
    capabilities: (caps) =>
      hasBodyRule
        ? {
            ...caps,
            signedUpload: {
              contentType: false,
              maxSize: false,
              supported: false,
            },
          }
        : caps,
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
            "Unsupported",
            "validation: signedUploadUrl() bypasses size and type checks (the client uploads directly, never through the plugin); upload through the Files instance to enforce them"
          );
        }
        return next(op);
      },
      upload: async (op, next) => {
        assertKey(op.key);
        let checked = op;
        if (allowedTypes !== undefined) {
          const type = resolveUploadType(
            op.options?.contentType,
            op.body,
            op.key
          );
          // Parse strictly before matching: a loose read of
          // `image/png;a=b, text/html` sees `image/png`, but a browser
          // renders the stored value as its last entry, `text/html`.
          const essence = mediaTypeEssence(type);
          if (essence === undefined) {
            throw new ValidationError(
              "type",
              `validation: "${op.key}" has a malformed content type ${JSON.stringify(type)}; declare exactly one media type, like "image/png"`
            );
          }
          if (!typeIsAllowed(essence, allowedTypes)) {
            throw new ValidationError(
              "type",
              `validation: "${op.key}" has type "${essence}", which is not one of the allowed types (${allowedTypes.join(", ")})`
            );
          }
          // Store the type that was approved. A key-inferred type would
          // otherwise be dropped (core never infers from the key), and the
          // object would land as the adapter's default instead.
          checked = {
            ...op,
            options: { ...op.options, contentType: storedType(type, essence) },
          };
        }
        // No size rule → nothing left to inspect; forward the body untouched
        // so streaming and resumable uploads keep working.
        if (maxSize === undefined && minSize === undefined) {
          return next(checked);
        }
        const { buffered, size } = await measure(op.body);
        assertSize(size, op.key);
        if (buffered === undefined) {
          return next(checked);
        }
        // The stream was drained to measure it: forward the buffer, so the
        // check stays outside the retry loop and a retry replays the same
        // bytes. A drained Blob's own type rides along, since bare bytes no
        // longer carry it.
        const blobType =
          op.body instanceof Blob && checked.options?.contentType === undefined
            ? op.body.type
            : "";
        return next({
          ...checked,
          body: buffered,
          ...(blobType !== "" && {
            options: { ...checked.options, contentType: blobType },
          }),
        });
      },
    }),
  };
};
