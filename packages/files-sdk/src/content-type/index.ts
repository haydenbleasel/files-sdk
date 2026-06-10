import { handlers } from "../index.js";
import type { Body, FilesOperation, FilesPlugin } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";

/** The single in-flight `upload` operation — the only verb this plugin touches. */
type UploadOp = Extract<FilesOperation, { kind: "upload" }>;

/**
 * What {@link contentType} does when the type it sniffs from the bytes disagrees
 * with the type the caller declared (or that the key's extension implies).
 *
 * - `"correct"` (the default) — overwrite the stored `Content-Type` with the
 *   sniffed one, so the object is always stored as what it actually *is*. A
 *   mislabeled file still lands, but under its true type.
 * - `"reject"` — throw, so a mislabeled upload never reaches the adapter. The
 *   security-hardening choice: a `.png` whose bytes are HTML is refused outright.
 *
 * A declared type of `application/octet-stream` (i.e. no real claim) is treated
 * as "unset" rather than a contradiction — the sniffed type fills it in under
 * both modes.
 */
export type OnMismatch = "correct" | "reject";

/**
 * What {@link contentType} does when the bytes match no known signature, so the
 * type can't be positively identified.
 *
 * - `"trust"` (the default) — keep the declared/inferred type. Sniffing only
 *   overrides types it's sure about, so an unrecognized but legitimate body
 *   (`.csv`, `.docx`, arbitrary binary) keeps its declared type untouched.
 * - `"reject"` — throw. A strict allowlist-by-signature posture: nothing lands
 *   unless its bytes are recognized.
 */
export type OnUnknown = "trust" | "reject";

export interface ContentTypeOptions {
  /**
   * How to reconcile a sniffed type that disagrees with the declared one.
   * Defaults to `"correct"`. See {@link OnMismatch}.
   */
  onMismatch?: OnMismatch;
  /**
   * What to do when the bytes match no known signature. Defaults to `"trust"`.
   * See {@link OnUnknown}.
   */
  onUnknown?: OnUnknown;
}

/** The fallback type that means "no real claim" — never a genuine contradiction. */
const GENERIC = "application/octet-stream";

/**
 * How many leading bytes to inspect. 512 is the conventional resource-header
 * window (it covers every signature below plus any XML prolog before an `<svg`),
 * and — crucially — it's all we read from a stream, so streaming uploads stay
 * streaming instead of being buffered whole.
 */
const SNIFF_BYTES = 512;

/** One contiguous run of magic bytes anchored at a fixed offset. */
type Segment = readonly [offset: number, bytes: readonly number[]];
/** A binary signature: every {@link Segment} must match for the type to apply. */
interface BinarySignature {
  readonly type: string;
  readonly segments: Segment[];
}

/**
 * Magic-byte signatures, in priority order. Deliberately scoped to the cases
 * where relabeling is unambiguous and useful — images and PDF — plus the
 * text-based active content (HTML/SVG) the text scan handles below. Container
 * formats whose magic bytes are shared by many real types (ZIP → docx/jar/epub,
 * gzip, the `ftyp` audio/video family) are intentionally absent: sniffing them
 * would mislabel more often than it would help.
 */
const BINARY_SIGNATURES: BinarySignature[] = [
  {
    segments: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
    type: "image/png",
  },
  { segments: [[0, [0xff, 0xd8, 0xff]]], type: "image/jpeg" },
  { segments: [[0, [0x47, 0x49, 0x46, 0x38]]], type: "image/gif" },
  { segments: [[0, [0x42, 0x4d]]], type: "image/bmp" },
  {
    segments: [
      [0, [0x52, 0x49, 0x46, 0x46]],
      [8, [0x57, 0x45, 0x42, 0x50]],
    ],
    type: "image/webp",
  },
  { segments: [[0, [0x49, 0x49, 0x2a, 0x00]]], type: "image/tiff" },
  { segments: [[0, [0x4d, 0x4d, 0x00, 0x2a]]], type: "image/tiff" },
  { segments: [[0, [0x00, 0x00, 0x01, 0x00]]], type: "image/x-icon" },
  { segments: [[0, [0x25, 0x50, 0x44, 0x46]]], type: "application/pdf" },
];

/** Whether `bytes` equals `sig` starting at `offset` (false if out of range). */
const matchesAt = (
  bytes: Uint8Array,
  offset: number,
  sig: readonly number[]
): boolean => {
  if (offset + sig.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[offset + i] !== sig[i]) {
      return false;
    }
  }
  return true;
};

/** Decode up to `len` bytes from `start` as ASCII, lowercasing `A`–`Z`. */
const asciiLower = (bytes: Uint8Array, start: number, len: number): string => {
  const end = Math.min(bytes.length, start + len);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const code = bytes[i] as number;
    out += String.fromCodePoint(
      code >= 0x41 && code <= 0x5a ? code + 0x20 : code
    );
  }
  return out;
};

/** Bytes that legally terminate a tag name (whitespace, `>`, or `/`). */
const TAG_TERMINATORS = new Set([" ", "\t", "\n", "\r", "\f", ">", "/"]);
/** Whitespace bytes skipped before the leading `<`, per the sniffing spec. */
const WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const LESS_THAN = 0x3c;
const UTF8_BOM: readonly number[] = [0xef, 0xbb, 0xbf];

/** Whether `head` opens the named tag (`<name` followed by a terminator/EOF). */
const opensTag = (head: string, name: string): boolean => {
  const prefix = `<${name}`;
  if (!head.startsWith(prefix)) {
    return false;
  }
  const next = head[prefix.length];
  return next === undefined || TAG_TERMINATORS.has(next);
};

/** HTML tag names whose presence at the top marks a body as `text/html`. */
const HTML_TAGS = [
  "html",
  "head",
  "body",
  "script",
  "iframe",
  "title",
  "table",
  "div",
  "a",
];

/**
 * Detect active text-based content — the security-relevant case the binary
 * table can't cover, since HTML and SVG have no fixed magic bytes. Skips a BOM
 * and leading whitespace, then matches the opening tag.
 */
const sniffText = (bytes: Uint8Array): string | undefined => {
  let i = matchesAt(bytes, 0, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (i < bytes.length && WHITESPACE.has(bytes[i] as number)) {
    i += 1;
  }
  if (bytes[i] !== LESS_THAN) {
    return;
  }
  const head = asciiLower(bytes, i, 32);
  if (head.startsWith("<!doctype html") || head.startsWith("<!--")) {
    return "text/html";
  }
  if (opensTag(head, "svg")) {
    return "image/svg+xml";
  }
  if (HTML_TAGS.some((tag) => opensTag(head, tag))) {
    return "text/html";
  }
  if (head.startsWith("<?xml")) {
    // An XML prolog can precede an `<svg>` root; scan a wider window for it.
    return asciiLower(bytes, i, SNIFF_BYTES).includes("<svg")
      ? "image/svg+xml"
      : "application/xml";
  }
};

/**
 * Identify the MIME type of a body from its leading bytes, or `undefined` when
 * the bytes match no known signature. Checks binary magic numbers (images, PDF)
 * first, then falls back to a text scan for HTML/SVG/XML. Exported so callers
 * can sniff outside the plugin; only the first {@link SNIFF_BYTES} bytes matter.
 */
export const detectContentType = (bytes: Uint8Array): string | undefined => {
  for (const { segments, type } of BINARY_SIGNATURES) {
    if (segments.every(([offset, sig]) => matchesAt(bytes, offset, sig))) {
      return type;
    }
  }
  return sniffText(bytes);
};

/** Strip any `; charset=…` parameter and normalize for comparison. */
const baseType = (value: string): string => {
  const semicolon = value.indexOf(";");
  return (semicolon === -1 ? value : value.slice(0, semicolon))
    .trim()
    .toLowerCase();
};

/**
 * The type the object would be stored as without sniffing: an explicit
 * `contentType` wins, then a `Blob`/`File`'s own `.type`, then the type the
 * key's extension implies (the SDK's own fallback).
 */
const declaredType = (body: Body, key: string, declared?: string): string => {
  if (declared !== undefined) {
    return declared;
  }
  if (body instanceof Blob && body.type) {
    return body.type;
  }
  return inferTypeFromName(key);
};

/**
 * Read the first `n` bytes of a non-stream body without materializing the whole
 * thing: a string is encoded only up to `n`, a `Blob` is sliced, and the array
 * shapes return a view over the existing buffer (no copy). The original body is
 * always forwarded unchanged — this only peeks.
 */
const headBytes = async (
  body: Exclude<Body, ReadableStream<Uint8Array>>,
  n: number
): Promise<Uint8Array> => {
  if (typeof body === "string") {
    const buf = new Uint8Array(n);
    const { written } = new TextEncoder().encodeInto(body, buf);
    return buf.subarray(0, written);
  }
  if (body instanceof Uint8Array) {
    return body.subarray(0, n);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body, 0, Math.min(n, body.byteLength));
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer,
      body.byteOffset,
      Math.min(n, body.byteLength)
    );
  }
  return new Uint8Array(await body.slice(0, n).arrayBuffer());
};

/**
 * Read the first `n` bytes off a stream and return them alongside a body that
 * replays the buffered prefix and then continues from where we stopped — so the
 * adapter still receives the full, original byte sequence, just one pass, never
 * buffered whole.
 */
const peekStream = async (
  stream: ReadableStream<Uint8Array>,
  n: number
): Promise<{ head: Uint8Array; body: ReadableStream<Uint8Array> }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        controller.enqueue(value);
      }
    },
    start(controller) {
      if (buffered.byteLength > 0) {
        controller.enqueue(buffered);
      }
      if (ended) {
        controller.close();
      }
    },
  });
  return { body, head: buffered.subarray(0, Math.min(n, total)) };
};

/**
 * A security guard that decides an upload's `Content-Type` from its **bytes**,
 * not the client's claim. It magic-byte-sniffs the body on `upload` and either
 * corrects the stored type to match (the default) or rejects a mismatch — so a
 * `.png` that's really HTML/SVG can't be stored under an image type and later
 * served inline.
 *
 * Recognizes the common images, PDF, and — the security-relevant part — HTML,
 * SVG, and XML, which have no fixed magic bytes and so are caught by a leading
 * text scan. Bodies it can't identify are left as-declared by default (see
 * {@link OnUnknown}).
 *
 * Unlike `compression()` / `encryption()`, it writes no metadata and only needs
 * the **first 512 bytes**, so it never buffers the whole body: known-length
 * bodies are peeked in place with no copy, and streams stay streaming (only the
 * prefix is read, then replayed). Reads, `url()`, `copy`, and `move` pass
 * straight through — there's nothing to undo.
 *
 * Place it **first**, before any body-transforming plugin, so it sniffs the
 * caller's original bytes: `plugins: [contentType(), compression(), encryption(key)]`.
 *
 * `signedUploadUrl()` hands upload capability to a client that writes directly,
 * bypassing the sniff, so it **fails closed** and throws.
 *
 * @param options `onMismatch` (`"correct"` default, or `"reject"`) and
 *   `onUnknown` (`"trust"` default, or `"reject"`).
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { contentType } from "files-sdk/content-type";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [contentType({ onMismatch: "reject" })],
 * });
 *
 * await files.upload("avatar.png", pngBytes); // ok — bytes are a PNG
 * await files.upload("avatar.png", htmlBytes); // throws — bytes are HTML
 * ```
 */
export const contentType = (options: ContentTypeOptions = {}): FilesPlugin => {
  const onMismatch = options.onMismatch ?? "correct";
  const onUnknown = options.onUnknown ?? "trust";

  /** Decide the op to forward (or throw) given the sniffed prefix. */
  const reconcile = (op: UploadOp, head: Uint8Array, body: Body): UploadOp => {
    const sniffed = detectContentType(head);
    if (sniffed === undefined) {
      if (onUnknown === "reject") {
        throw new FilesError(
          "Provider",
          `contentType: could not identify the contents of "${op.key}" from its signature`
        );
      }
      return { ...op, body };
    }
    const declared = baseType(
      declaredType(op.body, op.key, op.options?.contentType)
    );
    if (declared === sniffed) {
      return { ...op, body };
    }
    if (onMismatch === "reject" && declared !== GENERIC) {
      throw new FilesError(
        "Provider",
        `contentType: "${op.key}" is declared "${declared}" but its bytes are "${sniffed}"`
      );
    }
    return { ...op, body, options: { ...op.options, contentType: sniffed } };
  };

  return {
    name: "content-type",
    wrap: handlers({
      signedUploadUrl: () => {
        throw new FilesError(
          "Provider",
          "contentType: signedUploadUrl() bypasses magic-byte sniffing (the client uploads directly, never through the plugin); upload through the Files instance to enforce it"
        );
      },
      upload: async (op, next) => {
        if (op.body instanceof ReadableStream) {
          const { head, body } = await peekStream(op.body, SNIFF_BYTES);
          try {
            return await next(reconcile(op, head, body));
          } catch (error) {
            // A rejecting reconcile() (onMismatch/onUnknown: "reject") — or a
            // downstream failure before the replay body was consumed — would
            // otherwise leave the caller's source stream locked by the peek
            // reader and never cancelled, leaking its underlying request
            // body / file handle. A locked replay body is owned by whoever
            // locked it; cancelling here is best-effort.
            if (!body.locked) {
              try {
                await body.cancel();
              } catch {
                // The upload error below is what matters.
              }
            }
            throw error;
          }
        }
        const head = await headBytes(op.body, SNIFF_BYTES);
        return next(reconcile(op, head, op.body));
      },
    }),
  };
};
