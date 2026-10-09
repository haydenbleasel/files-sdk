// The byte-level helpers the webhook signature schemes share: HMAC and plain
// digests over Web Crypto, hex/base64 codecs, and a constant-time compare.
// Web Crypto only, so this runs on Node, Workers, Bun and Deno alike.

export type HashName = "SHA-1" | "SHA-256";

const encoder = new TextEncoder();

/** UTF-8 bytes, backed by a plain `ArrayBuffer` (what Web Crypto takes). */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(text);

export const concatBytes = (
  ...parts: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

/** Standard or URL-safe base64, padded or not. Throws on anything else. */
export const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

/** HMAC of `data` under the UTF-8 bytes of `secret`. */
export const hmac = async (
  hash: HashName,
  secret: string,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { hash, name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
};

export const digest = async (
  hash: HashName,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest(hash, data));

/** Compare two strings without leaking where they differ. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const left = utf8(a);
  const right = utf8(b);
  // oxlint-disable-next-line no-bitwise -- constant-time comparison
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) {
    // oxlint-disable-next-line no-bitwise -- constant-time comparison
    diff |= (left[i] ?? 0) ^ (right[i % Math.max(right.length, 1)] ?? 0);
  }
  return diff === 0;
};

/* oxlint-disable no-bitwise -- a non-cryptographic string hash is defined in terms of 32-bit integer mixing */
const hex32 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

/**
 * A fast, stable 64-bit hash of `text` (two cyrb53-style lanes over its UTF-8
 * bytes), as 16 hex digits. For idempotency keys, not for security: a
 * redelivery of the same text hashes the same.
 */
export const stableHash = (text: string): string => {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (const byte of utf8(text)) {
    h1 = Math.imul(h1 ^ byte, 2_654_435_761);
    h2 = Math.imul(h2 ^ byte, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return `${hex32(h2)}${hex32(h1)}`;
};
/* oxlint-enable no-bitwise */
