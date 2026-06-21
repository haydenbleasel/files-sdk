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

/**
 * A failure the router itself raises (authorization, validation, origin) — as
 * opposed to a `FilesError` bubbling up from a `Files` call. Carries a wire code
 * and optional `reason` directly.
 */
export class RouterError extends Error {
  readonly code: WireErrorCode;
  readonly reason?: WireErrorReason;

  constructor(code: WireErrorCode, message: string, reason?: WireErrorReason) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.reason = reason;
  }
}

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
    default: {
      return "Provider";
    }
  }
};

/** Serialize a `FilesError` to the wire shape — the safe subset, no `cause`. */
export const serializeFilesError = (error: FilesError): WireFilesError => ({
  aborted: error.aborted,
  code: error.code,
  message: error.message,
  timedOut: error.timedOut,
});

/** Map any thrown value to a wire error envelope + HTTP status. */
export const toErrorResult = (
  err: unknown
): { status: number; body: WireError } => {
  if (err instanceof RouterError) {
    const body: WireError["error"] = { code: err.code, message: err.message };
    if (err.reason) {
      body.reason = err.reason;
    }
    return { body: { error: body }, status: httpStatus(err.code) };
  }
  if (err instanceof FilesError) {
    const code = wireCodeFromFilesError(err.code);
    return {
      body: { error: { code, message: err.message } },
      status: httpStatus(code),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { body: { error: { code: "Provider", message } }, status: 500 };
};
