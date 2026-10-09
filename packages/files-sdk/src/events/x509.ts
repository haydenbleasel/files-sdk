// Just enough DER to pull the SubjectPublicKeyInfo out of an X.509
// certificate, so Web Crypto can import the key (`importKey("spki", …)`) on
// runtimes without `X509Certificate` (Workers, browsers). It doesn't validate
// the certificate — the caller trusts it because of where it was fetched
// from (a pinned host over HTTPS), not because of its contents.

import { FilesError } from "../internal/errors.js";
import { fromBase64 } from "./crypto.js";

const SEQUENCE = 0x30;
const VERSION = 0xa0;

interface Tlv {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

const invalid = (): FilesError =>
  new FilesError(
    "Unauthorized",
    "files-sdk/events: signing certificate is not a DER X.509 certificate",
    undefined,
    { permanent: true }
  );

const readTlv = (bytes: Uint8Array, offset: number): Tlv => {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  if (tag === undefined || length === undefined) {
    throw invalid();
  }
  let contentStart = offset + 2;
  if (length >= 0x80) {
    const count = length - 0x80;
    if (count < 1 || count > 4) {
      throw invalid();
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = bytes[contentStart + i];
      if (byte === undefined) {
        throw invalid();
      }
      length = length * 256 + byte;
    }
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > bytes.length) {
    throw invalid();
  }
  return { contentStart, end, start: offset, tag };
};

/** The DER bytes of a PEM `CERTIFICATE` block. */
export const pemToDer = (pem: string): Uint8Array<ArrayBuffer> => {
  const body = pem.replaceAll(/-----(?:BEGIN|END) CERTIFICATE-----|\s+/gu, "");
  try {
    return fromBase64(body);
  } catch {
    throw invalid();
  }
};

/**
 * The SubjectPublicKeyInfo of a DER certificate:
 * `Certificate → tbsCertificate → [version] serial, signature, issuer,
 * validity, subject, subjectPublicKeyInfo`.
 */
export const spkiOf = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.contentStart);
  if (certificate.tag !== SEQUENCE || tbs.tag !== SEQUENCE) {
    throw invalid();
  }
  let field = readTlv(der, tbs.contentStart);
  if (field.tag === VERSION) {
    field = readTlv(der, field.end);
  }
  // serial → signature → issuer → validity → subject → subjectPublicKeyInfo
  for (let i = 0; i < 5; i += 1) {
    field = readTlv(der, field.end);
  }
  if (field.tag !== SEQUENCE) {
    throw invalid();
  }
  return der.slice(field.start, field.end);
};
