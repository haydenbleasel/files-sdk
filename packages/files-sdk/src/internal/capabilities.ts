// Capability intersection for the multi-backend plugins. `failover()` and
// `tiering()` drive more than one adapter behind one instance, so what the
// instance can promise is what every backend can do: an option one backend
// refuses would otherwise pass the up-front gate and throw only once an
// operation lands there (after a failover, or on a cold-routed key).

import type {
  AdapterCapabilities,
  DelimiterSupport,
  SignedUploadCapability,
  SignedUrlCapability,
  SignedUrlExpiry,
} from "../index.js";

/** `list({ delimiter })` support both backends share. */
const weakestDelimiter = (
  a: DelimiterSupport,
  b: DelimiterSupport
): DelimiterSupport => {
  if (a === false || b === false) {
    return false;
  }
  return a === "any" && b === "any" ? "any" : "slash";
};

/** Strength order of {@link SignedUrlExpiry}, weakest first. */
const EXPIRY_ORDER: readonly SignedUrlExpiry[] = ["none", "provider", "exact"];

const weakestExpiry = (
  a: SignedUrlExpiry,
  b: SignedUrlExpiry
): SignedUrlExpiry =>
  EXPIRY_ORDER.indexOf(a) <= EXPIRY_ORDER.indexOf(b) ? a : b;

/** The `maxExpiresIn` field both URL capabilities carry. */
type ExpiryCap = Pick<SignedUrlCapability, "maxExpiresIn">;

/** The tighter of two optional code-enforced caps (absent = no cap). */
const tighterCap = (
  a: number | undefined,
  b: number | undefined
): ExpiryCap => {
  if (a === undefined) {
    return b === undefined ? {} : { maxExpiresIn: b };
  }
  return { maxExpiresIn: b === undefined ? a : Math.min(a, b) };
};

const intersectSignedUrl = (
  a: SignedUrlCapability,
  b: SignedUrlCapability
): SignedUrlCapability => {
  if (!(a.supported && b.supported)) {
    return { disposition: false, expiry: "none", supported: false };
  }
  return {
    disposition: a.disposition && b.disposition,
    expiry: weakestExpiry(a.expiry, b.expiry),
    ...tighterCap(a.maxExpiresIn, b.maxExpiresIn),
    supported: true,
  };
};

const intersectSignedUpload = (
  a: SignedUploadCapability,
  b: SignedUploadCapability
): SignedUploadCapability => {
  if (!(a.supported && b.supported)) {
    return { contentType: false, maxSize: false, supported: false };
  }
  return {
    contentType: a.contentType && b.contentType,
    maxSize: a.maxSize && b.maxSize,
    ...tighterCap(a.maxExpiresIn, b.maxExpiresIn),
    supported: true,
  };
};

/**
 * What `a` and `b` can both do: every boolean ANDed, the weaker `delimiter`
 * and URL expiry, and the tighter `maxExpiresIn`. `conditional` and `events`
 * come from `a` unchanged — they describe the instance's own adapter (the
 * primary, the hot tier), and each plugin decides them itself.
 */
export const intersectCapabilities = (
  a: AdapterCapabilities,
  b: AdapterCapabilities
): AdapterCapabilities => ({
  cacheControl: a.cacheControl && b.cacheControl,
  conditional: a.conditional,
  delimiter: weakestDelimiter(a.delimiter, b.delimiter),
  events: a.events,
  metadata: a.metadata && b.metadata,
  publicUrl: a.publicUrl && b.publicUrl,
  rangeRead: a.rangeRead && b.rangeRead,
  resumable: a.resumable && b.resumable,
  serverSideCopy: a.serverSideCopy && b.serverSideCopy,
  signedUpload: intersectSignedUpload(a.signedUpload, b.signedUpload),
  signedUrl: intersectSignedUrl(a.signedUrl, b.signedUrl),
  uploadProgress: a.uploadProgress && b.uploadProgress,
});
