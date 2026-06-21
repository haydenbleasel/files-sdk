// Stateless HMAC tokens for the upload round-trip (`presign` → direct-to-storage
// → `complete`). The token binds the server-chosen key and the size/type
// constraints so the server stays stateless between the two requests and a
// client cannot forge a key or relax a constraint. Uses Web Crypto
// (`crypto.subtle`), so it runs on Node, edge runtimes, Bun, and Deno alike.

export interface TokenPayload {
  key: string;
  contentType?: string;
  maxSize?: number;
  minSize?: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; failure: "malformed" | "signature" | "expired" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

// Web Crypto's BufferSource excludes SharedArrayBuffer-backed views; our bytes
// never share, so assert the ArrayBuffer backing (matches the encryption plugin).
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> =>
  value as Uint8Array<ArrayBuffer>;

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    bytes(encoder.encode(secret)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );

export const signToken = async (
  payload: TokenPayload,
  secret: string
): Promise<string> => {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    bytes(encoder.encode(body))
  );
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
};

export const verifyToken = async (
  token: string,
  secret: string,
  now: number = Date.now()
): Promise<VerifyResult> => {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { failure: "malformed", ok: false };
  }
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid: boolean;
  try {
    const key = await importKey(secret);
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      bytes(fromBase64Url(signature)),
      bytes(encoder.encode(body))
    );
  } catch {
    return { failure: "malformed", ok: false };
  }
  if (!valid) {
    return { failure: "signature", ok: false };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body))) as TokenPayload;
  } catch {
    return { failure: "malformed", ok: false };
  }
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { failure: "expired", ok: false };
  }
  return { ok: true, payload };
};
