// Error wire-shaping shared by the gateway: map a thrown value (router-level
// `RouterError`, an SDK `FilesError`, or anything else) to the `{ error: {...} }`
// envelope + an HTTP status, never leaking `FilesError.cause` across the trust
// boundary (mirrors the CLI's `filesErrorReplacer`).

import type { FilesErrorCode } from "../errors.js";
import { FilesError } from "../errors.js";
import type {
  WireError,
  WireErrorCode,
  WireErrorReason,
  WireFilesError,
} from "../files-router/protocol.js";
import { isObject } from "../is.js";

// The gateway core is bundled into both the edge pass (`files-sdk/api`) and the
// Node pass (`files-sdk/nestjs`, which builds its router internally), so an app
// can hold two copies of this class — `UploadRejectedError` imported from
// `files-sdk/api` and thrown into a NestJS-mounted router, say. The registry
// brand lets `instanceof` match across copies, like `FilesError`'s.
const ROUTER_ERROR_BRAND = Symbol.for("files-sdk.RouterError");

/**
 * A failure the router itself raises (authorization, validation, origin) — as
 * opposed to a `FilesError` bubbling up from a `Files` call. Carries a wire code
 * and optional `reason` directly.
 */
export class RouterError extends Error {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `instanceof` hands any value to `Symbol.hasInstance`; this method is the check
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== RouterError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return isObject(value) && ROUTER_ERROR_BRAND in value;
  }

  readonly code: WireErrorCode;
  readonly reason?: WireErrorReason;
  /** HTTP status override (e.g. 413 for an oversized request); else derived from `code`. */
  readonly status?: number;

  constructor(
    code: WireErrorCode,
    message: string,
    reason?: WireErrorReason,
    status?: number
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

// Set once on the prototype so subclasses (`UploadRejectedError`) inherit it and
// it stays off the wire (`JSON.stringify`/`Object.keys`).
Object.defineProperty(RouterError.prototype, ROUTER_ERROR_BRAND, {
  value: true,
});

export const httpStatus = (code: WireErrorCode): number => {
  switch (code) {
    case "Unauthorized": {
      return 401;
    }
    case "Forbidden":
    case "ReadOnly": {
      return 403;
    }
    case "NotFound": {
      return 404;
    }
    case "Conflict": {
      return 409;
    }
    case "Unsupported":
    case "Validation": {
      return 422;
    }
    default: {
      return 500;
    }
  }
};

const wireCodeFromFilesError = (code: FilesErrorCode): WireErrorCode => {
  switch (code) {
    case "NotFound": {
      return "NotFound";
    }
    case "Unauthorized": {
      return "Unauthorized";
    }
    case "Conflict": {
      return "Conflict";
    }
    case "ReadOnly": {
      return "ReadOnly";
    }
    // A malformed call is the client's to fix, like the gateway's own
    // request validation; an unsupported one is a 422 the client can branch on.
    case "Invalid": {
      return "Validation";
    }
    case "Unsupported": {
      return "Unsupported";
    }
    default: {
      return "Provider";
    }
  }
};

/**
 * Storage keys (and list prefixes) the request resolved, mapped to what the
 * client sent. A provider's error message names the storage key — authorize's
 * `keyPrefix` included — so the message is rewritten to the caller's own key
 * before it crosses the wire: one tenant never learns how its keys are laid
 * out in the bucket.
 */
export type KeyRedactions = ReadonlyMap<string, string>;

/** `message` with every resolved storage key replaced by the client's key. */
export const redactKeys = (
  message: string,
  redactions: KeyRedactions | undefined
): string => {
  if (!redactions || redactions.size === 0) {
    return message;
  }
  let out = message;
  // Longest first, so a key never clobbers part of a longer one it prefixes.
  const entries = [...redactions].toSorted((a, b) => b[0].length - a[0].length);
  for (const [storage, client] of entries) {
    if (storage !== client && storage !== "") {
      out = out.replaceAll(storage, client);
    }
  }
  return out;
};

// Errors an app hook threw for its client on purpose — `authorize`, the
// per-request `files` factory, `onUploadComplete`. Their message is the app's
// answer to the caller ("sign in", "video not found"), so it crosses the wire
// whatever its code.
const clientFacing = new WeakSet<object>();

/**
 * Mark `error` as thrown by an app hook for the client to read: its message is
 * sent as-is (keys still redacted), even under a code whose adapter-raised
 * messages are withheld. Returns `error`, so a `catch` can rethrow the result.
 */
export const markClientFacing = <T>(error: T): T => {
  if (isObject(error)) {
    clientFacing.add(error);
  }
  return error;
};

/**
 * What the client hears for a `FilesError` code whose message the storage
 * layer wrote. A provider's message can carry anything — the `fs` adapter's
 * absolute paths (`ENOENT … lstat '/var/app/…'`), an internal hostname, the
 * bucket name — so for these codes the code and status still reach the
 * client, but only a fixed message does.
 */
const WITHHELD_MESSAGES: Partial<Record<FilesErrorCode, string>> = {
  Conflict: "the request conflicts with the file's current state",
  NotFound: "not found",
  Provider: "storage provider error",
  Unauthorized: "storage access denied",
};

/**
 * The message the client may read for `error`. The SDK's own refusals
 * (`Invalid`, `Unsupported`, `ReadOnly`) and an app hook's errors are sent
 * with every resolved storage key rewritten to the client's; anything a
 * provider answered gets the fixed message for its code.
 */
export const clientErrorMessage = (
  error: FilesError,
  redactions?: KeyRedactions
): string => {
  const withheld = WITHHELD_MESSAGES[error.code];
  if (withheld === undefined || clientFacing.has(error)) {
    return redactKeys(error.message, redactions);
  }
  if (error.timedOut) {
    return "storage request timed out";
  }
  return error.aborted ? "request aborted" : withheld;
};

/** Serialize a `FilesError` to the wire shape — the safe subset, no `cause`. */
export const serializeFilesError = (
  error: FilesError,
  redactions?: KeyRedactions
): WireFilesError => ({
  aborted: error.aborted,
  code: error.code,
  message: clientErrorMessage(error, redactions),
  timedOut: error.timedOut,
});

/**
 * What the client hears about a failure that is neither a `FilesError` nor a
 * `RouterError` — a bug, or a plain `Error` an app hook threw. Its message can
 * carry anything (a connection string, a SQL error), so it never crosses the
 * wire; the router's `onError` gets the original.
 */
export const INTERNAL_ERROR_MESSAGE = "internal server error";

/**
 * Whether the router's `onError` should get `cause`: a failure the client only
 * hears about generically, so its detail would otherwise be lost. That's
 * anything that isn't a `RouterError` or `FilesError`, plus a storage-layer
 * `Provider` or `Unauthorized` error (the backend failed, or refused the
 * gateway's own credentials) that wasn't a cancelled request. An app hook's
 * deliberate `FilesError` and a routine `NotFound`/`Conflict` aren't reported.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a predicate over whatever a `catch` caught
export const isReportedError = (cause: unknown): boolean => {
  if (cause instanceof RouterError) {
    return false;
  }
  if (!(cause instanceof FilesError)) {
    return true;
  }
  return (
    (cause.code === "Provider" || cause.code === "Unauthorized") &&
    !cause.aborted &&
    !clientFacing.has(cause)
  );
};

export interface ErrorResult {
  status: number;
  body: WireError;
}

/**
 * Map any thrown value to a wire error envelope + HTTP status. Anything other
 * than a `RouterError`/`FilesError` is a generic 500 — its message stays on the
 * server (see {@link INTERNAL_ERROR_MESSAGE}) — and a `FilesError`'s message is
 * filtered by {@link clientErrorMessage}.
 */
export const toErrorResult = (
  cause: unknown,
  redactions?: KeyRedactions
): ErrorResult => {
  if (cause instanceof RouterError) {
    const body: WireError["error"] = {
      code: cause.code,
      message: redactKeys(cause.message, redactions),
    };
    if (cause.reason) {
      body.reason = cause.reason;
    }
    return {
      body: { error: body },
      status: cause.status ?? httpStatus(cause.code),
    };
  }
  if (cause instanceof FilesError) {
    const code = wireCodeFromFilesError(cause.code);
    return {
      body: {
        error: { code, message: clientErrorMessage(cause, redactions) },
      },
      status: httpStatus(code),
    };
  }
  return {
    body: { error: { code: "Provider", message: INTERNAL_ERROR_MESSAGE } },
    status: 500,
  };
};
