import type { Body } from "../index.js";

/**
 * The mutating verbs a {@link Receipt} is emitted for — the same write set the
 * SDK gates on, minus `signedUploadUrl` (minting an upload URL transfers no
 * bytes, so there's nothing to fingerprint). A receipt records "this content
 * landed at this key", which only `upload`, `delete`, `copy`, and `move`
 * describe.
 */
export type ReceiptOp = "upload" | "delete" | "copy" | "move";

/**
 * The full receipt configuration, after normalizing the
 * `receipts?: boolean | { sha256?: boolean }` constructor option. `enabled`
 * gates emission entirely (default `false` = zero behavior change); `sha256`
 * gates the one field with a per-call cost.
 */
export interface ReceiptsConfig {
  enabled: boolean;
  sha256: boolean;
}

/**
 * Normalize the public `receipts` option into a {@link ReceiptsConfig}.
 *
 * - `undefined` / `false` → off (no receipts, no hashing, no behavior change).
 * - `true` → receipts on, **without** sha256 (the costly field stays off until
 *   asked for by name).
 * - `{ sha256: true }` → receipts on, body fingerprinting on.
 */
export const resolveReceiptsConfig = (
  receipts: boolean | { sha256?: boolean } | undefined
): ReceiptsConfig => {
  if (!receipts) {
    return { enabled: false, sha256: false };
  }
  if (receipts === true) {
    return { enabled: true, sha256: false };
  }
  return { enabled: true, sha256: receipts.sha256 === true };
};

/**
 * A provenance record for a single mutating call, made available only when the
 * `receipts` option is on. Every field except `sha256` is **derived** from the
 * action the SDK already tracks for its observability hooks — timing, the
 * adapter, the caller-facing key, the stored byte size, the etag — so a receipt
 * adds no work beyond what the hook payload already computed.
 *
 * `sha256` is the sole genuinely new field, and the only one with a real
 * per-call cost: it's the lowercase-hex SHA-256 of the uploaded bytes, computed
 * **only** when `receipts: { sha256: true }` is set, and present **only** on an
 * `upload` of a buffered body. It is omitted (left `undefined`) when not asked
 * for, on non-`upload` ops, and on streaming uploads (whose bytes the SDK never
 * buffers).
 */
export interface Receipt {
  /** The mutating verb that produced this receipt. */
  op: ReceiptOp;
  /** The storage provider, from the adapter's `name` (e.g. `"s3"`, `"r2"`). */
  provider: string;
  /**
   * Caller-facing key the content landed at — the upload/delete key, or a
   * `copy` / `move` destination. Always the un-prefixed key the caller passed.
   */
  key: string;
  /** Stored byte size, when the settled result reports one (`upload`). */
  bytes?: number;
  /** Lowercase-hex SHA-256 of the uploaded bytes — see {@link Receipt}. */
  sha256?: string;
  /** Entity tag the provider returned, when present (`upload`). */
  etag?: string;
  /** Wall-clock duration of the public call, in milliseconds. */
  durationMs: number;
  /** When the call settled, in ms since the epoch. */
  ts: number;
}

/** The action-derived inputs a {@link Receipt} is assembled from. */
export interface ReceiptInput {
  op: ReceiptOp;
  provider: string;
  key: string;
  bytes?: number;
  etag?: string;
  sha256?: string;
  durationMs: number;
  ts: number;
}

/**
 * Assemble a {@link Receipt} from the fields the action wrapper already holds,
 * plus an optional pre-computed `sha256`. Optional fields are omitted (rather
 * than set to `undefined`) so a receipt for a `delete` is `{ op, provider, key,
 * durationMs, ts }` with no dangling keys.
 */
export const buildReceipt = (input: ReceiptInput): Receipt => ({
  durationMs: input.durationMs,
  key: input.key,
  op: input.op,
  provider: input.provider,
  ts: input.ts,
  ...(input.bytes !== undefined && { bytes: input.bytes }),
  ...(input.etag !== undefined && { etag: input.etag }),
  ...(input.sha256 !== undefined && { sha256: input.sha256 }),
});

/**
 * The mutating action types that map onto a {@link ReceiptOp}. `signedUploadUrl`
 * is intentionally excluded — see {@link ReceiptOp}.
 */
const RECEIPT_OPS = new Set<string>(["upload", "delete", "copy", "move"]);

/** Narrow a {@link FilesActionType} to a {@link ReceiptOp}, or `undefined`. */
export const receiptOpFor = (type: string): ReceiptOp | undefined =>
  RECEIPT_OPS.has(type) ? (type as ReceiptOp) : undefined;

/**
 * Lowercase-hex SHA-256 of `bytes`, via Web Crypto (the same `crypto.subtle`
 * the encryption adapter uses, available on every runtime the SDK targets).
 * The only place in the receipts path that does per-call work, called solely
 * when `receipts: { sha256: true }` is set on a buffered upload.
 */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Web Crypto's BufferSource is pinned to ArrayBuffer backing (not
  // SharedArrayBuffer); our upload bytes never share, so assert it here — the
  // same pattern the encryption adapter uses.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/**
 * The uploaded body as a `Uint8Array` when it's already buffered (string,
 * `Uint8Array`, `ArrayBuffer`, typed-array view, or `Blob`), or `undefined` for
 * a `ReadableStream` — which the SDK streams straight to the adapter and never
 * buffers, so a stream upload yields no `sha256`. Reading a buffered body here
 * is non-consuming; reading a stream would consume it, so it's deliberately
 * skipped rather than teed.
 */
export const bufferedBodyBytes = async (
  body: Body
): Promise<Uint8Array | undefined> => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  return undefined;
};
