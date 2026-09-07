import { handlers } from "../index.js";
import type { FilesPlugin, StoredFile } from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

/**
 * A master key (KEK) for {@link encryption}. Either a Web Crypto
 * {@link CryptoKey} usable for `encrypt`/`decrypt`, or raw AES key bytes of 16,
 * 24, or 32 bytes (e.g. a secret pulled from an environment variable, imported
 * for you on first use).
 */
export type EncryptionKey = CryptoKey | Uint8Array | ArrayBuffer;

const ALGORITHM = "AES-GCM";
/** Marks the metadata format; bump if the envelope layout ever changes. */
const SCHEME = "aes-gcm/envelope/v1";
/** Prefix for every field this plugin stashes in object metadata. */
const META_PREFIX = "fsenc_";
const META = {
  dek: `${META_PREFIX}dek`,
  dekIv: `${META_PREFIX}dek_iv`,
  iv: `${META_PREFIX}iv`,
  scheme: `${META_PREFIX}scheme`,
  size: `${META_PREFIX}size`,
} as const;

const IV_BYTES = 12;
const KEY_BITS = 256;
const RAW_KEY_BYTES = new Set([16, 24, 32]);
const RADIX = 10;

const toBase64 = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return btoa(String.fromCodePoint(...bytes));
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (char) => char.codePointAt(0) ?? 0);

const randomIv = (): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(IV_BYTES));

/** Drop this plugin's internal fields; return `undefined` when nothing remains. */
const stripInternalMeta = (
  metadata: Record<string, string>
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(META_PREFIX)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Re-report a stored file's logical (plaintext) size and hide the internal
 * metadata fields, without touching the body. Used by `head` and `list`, which
 * never decrypt. Objects this plugin didn't write pass through untouched.
 */
const correctMeta = (file: StoredFile): StoredFile => {
  const { metadata } = file;
  if (!metadata?.[META.scheme]) {
    return file;
  }
  const size = Number.parseInt(metadata[META.size] ?? "", RADIX);
  return {
    ...file,
    metadata: stripInternalMeta(metadata),
    size: Number.isNaN(size) ? file.size : size,
  };
};

const importRawKey = (bytes: Uint8Array): Promise<CryptoKey> => {
  if (!RAW_KEY_BYTES.has(bytes.byteLength)) {
    throw new FilesError(
      "Provider",
      `encryption: a raw key must be 16, 24, or 32 bytes, received ${bytes.byteLength}`
    );
  }
  return crypto.subtle.importKey(
    "raw",
    // SAFETY: Web Crypto's BufferSource excludes SharedArrayBuffer-backed
    // views; a key never shares, so the ArrayBuffer backing holds.
    bytes as Uint8Array<ArrayBuffer>,
    { name: ALGORITHM },
    false,
    ["decrypt", "encrypt"]
  );
};

const resolveKek = (key: EncryptionKey): Promise<CryptoKey> => {
  if (key instanceof Uint8Array) {
    return importRawKey(key);
  }
  if (key instanceof ArrayBuffer) {
    return importRawKey(new Uint8Array(key));
  }
  return Promise.resolve(key);
};

/** Envelope-seal one plaintext buffer: per-object DEK, KEK-wrapped. */
const seal = async (
  plaintext: Uint8Array,
  kek: CryptoKey
): Promise<{
  bodyIv: Uint8Array;
  ciphertext: ArrayBuffer;
  dekIv: Uint8Array;
  wrappedDek: ArrayBuffer;
}> => {
  const dek = await crypto.subtle.generateKey(
    { length: KEY_BITS, name: ALGORITHM },
    true,
    ["encrypt"]
  );
  const bodyIv = randomIv();
  const ciphertext = await crypto.subtle.encrypt(
    { iv: bodyIv, name: ALGORITHM },
    dek,
    // SAFETY: Web Crypto's BufferSource is pinned to ArrayBuffer backing (not
    // SharedArrayBuffer); our plaintext never shares, so the backing holds.
    plaintext as Uint8Array<ArrayBuffer>
  );
  const dekIv = randomIv();
  const wrappedDek = await crypto.subtle.encrypt(
    { iv: dekIv, name: ALGORITHM },
    kek,
    await crypto.subtle.exportKey("raw", dek)
  );
  return { bodyIv, ciphertext, dekIv, wrappedDek };
};

/** Reverse {@link seal}: unwrap the DEK, then decrypt the body. */
const open = async (
  metadata: Record<string, string>,
  ciphertext: ArrayBuffer,
  kek: CryptoKey
): Promise<ArrayBuffer> => {
  const rawDek = await crypto.subtle.decrypt(
    { iv: fromBase64(metadata[META.dekIv] ?? ""), name: ALGORITHM },
    kek,
    fromBase64(metadata[META.dek] ?? "")
  );
  const dek = await crypto.subtle.importKey(
    "raw",
    rawDek,
    { name: ALGORITHM },
    false,
    ["decrypt"]
  );
  return await crypto.subtle.decrypt(
    { iv: fromBase64(metadata[META.iv] ?? ""), name: ALGORITHM },
    dek,
    ciphertext
  );
};

/**
 * Generate a fresh 256-bit AES-GCM master key for {@link encryption}. The key
 * is extractable, so you can `crypto.subtle.exportKey("raw", key)` it to persist
 * in a secret manager and re-import it (or pass the raw bytes back to
 * {@link encryption}) later.
 */
export const generateEncryptionKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ length: KEY_BITS, name: ALGORITHM }, true, [
    "decrypt",
    "encrypt",
  ]);

/**
 * Envelope-encrypt object bodies at rest. On `upload` a fresh per-object data
 * key (DEK) encrypts the body with AES-256-GCM; the master key (KEK) you pass in
 * encrypts ("wraps") that DEK, and both the wrapped DEK and the IVs ride along in
 * the object's `metadata`. On `download` the DEK is unwrapped and the body
 * decrypted — transparently, in the right order, for `upload([...])` /
 * `download([...])` bulk calls too.
 *
 * Provider-agnostic: it uses only the Web Crypto API (no native deps) and the
 * `metadata` the SDK already round-trips, so it works on any adapter that
 * supports metadata.
 *
 * Place it **last** in the plugin array so it's the innermost layer — anything
 * that needs to see plaintext (compression, validation, virus scanning) must run
 * before it: `plugins: [compression(), encryption(key)]`.
 *
 * Trade-offs, by design:
 * - **Buffers the whole body** to compute the GCM tag, so it's unsuitable for
 *   unknown-length streams and resumable uploads.
 * - **Range downloads throw** — a slice of a GCM ciphertext can't be decrypted.
 * - **`url()` / `signedUploadUrl()` throw** — presigned URLs bypass the plugin,
 *   handing out ciphertext or letting a client store plaintext.
 * - **`copy` / `move` just work** — the wrapped DEK travels with the object.
 * - Objects without this plugin's marker (pre-existing or written elsewhere)
 *   **pass through** on read, so it's safe to enable on a mixed bucket.
 *
 * Threat model: this protects **confidentiality at rest** — a party who reads
 * raw provider bytes (or metadata) learns nothing about the plaintext beyond
 * its length, and any tampering with the ciphertext, the wrapped DEK, the
 * IVs, or the declared size fails loudly at decrypt time. It is **not**
 * integrity binding between an envelope and its key: an attacker with raw
 * provider *write* access can copy one object's whole envelope (ciphertext +
 * `fsenc_*` metadata) onto another key, and a later download of that key will
 * decrypt cleanly to the other object's plaintext. Binding envelopes to keys
 * (à la KMS encryption context) would break the server-side `copy`/`move`
 * and key-aliasing plugin compositions above by design — if cross-object
 * splicing is in your threat model, isolate tenants with separate KEKs and
 * lock down provider write access.
 *
 * @param key the master key — a {@link CryptoKey} or raw 16/24/32 key bytes.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { encryption, generateEncryptionKey } from "files-sdk/encryption";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [encryption(await generateEncryptionKey())],
 * });
 *
 * await files.upload("secret.txt", "hello"); // stored encrypted
 * await (await files.download("secret.txt")).text(); // "hello"
 * ```
 */
export const encryption = (key: EncryptionKey): FilesPlugin => {
  let kek: Promise<CryptoKey> | undefined;
  const getKek = (): Promise<CryptoKey> => {
    kek ??= resolveKek(key);
    return kek;
  };

  return {
    name: "encryption",
    wrap: handlers({
      download: async (op, next) => {
        if (op.options?.range) {
          throw new FilesError(
            "Provider",
            `encryption: range downloads are unsupported on encrypted objects ("${op.key}")`
          );
        }
        const file = await next(op);
        const { metadata } = file;
        if (!metadata?.[META.scheme]) {
          return file;
        }
        const ciphertext = await file.arrayBuffer();
        let plaintext: ArrayBuffer;
        try {
          plaintext = await open(metadata, ciphertext, await getKek());
        } catch (error) {
          throw new FilesError(
            "Provider",
            `encryption: failed to decrypt "${op.key}" (wrong key or corrupted data)`,
            error
          );
        }
        // GCM authenticates the body and the wrapped DEK, but `fsenc_size`
        // is plain metadata — the one envelope field an attacker with raw
        // provider write access could forge (head/list report it without
        // decrypting). Where decryption *does* happen, verify it.
        const declaredSize = Number.parseInt(metadata[META.size] ?? "", RADIX);
        if (
          !Number.isNaN(declaredSize) &&
          declaredSize !== plaintext.byteLength
        ) {
          throw new FilesError(
            "Provider",
            `encryption: "${op.key}" decrypted to ${plaintext.byteLength} bytes but its envelope declares ${declaredSize} — the metadata has been tampered with`
          );
        }
        return createStoredFile(
          {
            etag: file.etag,
            key: file.key,
            lastModified: file.lastModified,
            metadata: stripInternalMeta(metadata),
            size: plaintext.byteLength,
            type: file.type,
          },
          { data: new Uint8Array(plaintext), kind: "buffer" }
        );
      },
      head: async (op, next) => correctMeta(await next(op)),
      list: async (op, next) => {
        const result = await next(op);
        return { ...result, items: result.items.map(correctMeta) };
      },
      signedUploadUrl: () => {
        throw new FilesError(
          "Provider",
          "encryption: signedUploadUrl() bypasses at-rest encryption (the client would store unencrypted bytes); upload through the Files instance instead"
        );
      },
      upload: async (op, next) => {
        const normalized = await normalizeBody(
          op.body,
          op.options?.contentType
        );
        const plaintext =
          normalized.data instanceof Uint8Array
            ? normalized.data
            : await collectStream(normalized.data);
        const sealed = await seal(plaintext, await getKek());
        const result = await next({
          ...op,
          body: new Uint8Array(sealed.ciphertext),
          options: {
            ...op.options,
            contentType: normalized.contentType,
            metadata: {
              ...op.options?.metadata,
              [META.dek]: toBase64(sealed.wrappedDek),
              [META.dekIv]: toBase64(sealed.dekIv),
              [META.iv]: toBase64(sealed.bodyIv),
              [META.scheme]: SCHEME,
              [META.size]: String(plaintext.byteLength),
            },
          },
        });
        return { ...result, size: plaintext.byteLength };
      },
      url: () => {
        throw new FilesError(
          "Provider",
          "encryption: url() returns a link to ciphertext that clients cannot decrypt; download through the Files instance instead"
        );
      },
    }),
  };
};
