import { isObject } from "./is.js";

export type FilesErrorCode =
  | "NotFound"
  | "Unauthorized"
  | "Conflict"
  | "ReadOnly"
  | "Provider";

export type ProviderFilesErrorCode = Exclude<FilesErrorCode, "ReadOnly">;

// Edge, Node and client-framework entries are bundled in separate passes, so a
// consumer can load more than one copy of this class (`files-sdk` and
// `files-sdk/api` each ship their own). The brand lets `instanceof` match
// across copies.
const FILES_ERROR_BRAND = Symbol.for("files-sdk.FilesError");

export class FilesError extends Error {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `instanceof` hands any value to `Symbol.hasInstance`; this method is the check
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== FilesError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return isObject(value) && FILES_ERROR_BRAND in value;
  }

  readonly code: FilesErrorCode;
  readonly aborted: boolean;
  /**
   * `true` when the operation was cut off by a configured `timeout` rather
   * than a caller's abort signal. Timeouts also set `aborted` (the attempt
   * was cancelled either way), so this is the bit that tells "the backend
   * hung" apart from "the caller changed their mind" — `failover()` uses it
   * to try the next backend on a timeout but respect a deliberate abort.
   */
  readonly timedOut: boolean;
  /**
   * `true` when the failure is deterministic — re-issuing the identical
   * request can only fail the same way (a host that ignores `Range`, a
   * delimiter the provider can't honor). `Provider`-coded errors are
   * otherwise presumed transient and retried; this flag opts a specific
   * failure out of that.
   */
  readonly permanent: boolean;
  /**
   * `true` when a conditional mutation **did commit** at the provider before
   * this error was raised — an awaited plugin threw after `next()` returned,
   * or the committed result failed a post-commit check. The object changed
   * (for an upload, to the generation in {@link appliedEtag}) even though the
   * call rejected, so treat it as applied-but-unacknowledged: reconcile with
   * an exact read rather than re-issuing the same predicate, which can only
   * conflict now. Never set on a pre-commit veto or a provider failure.
   */
  readonly applied: boolean;
  /** The committed generation's ETag when {@link applied} is set on an upload. */
  readonly appliedEtag?: string;
  /**
   * The original provider error, preserved for debugging.
   *
   * **Logging note:** provider errors (especially from `@aws-sdk`) can carry
   * fields like request IDs, response headers, and partial request metadata.
   * If you serialize `FilesError` into logs that cross a trust boundary,
   * consider stripping `cause` or whitelisting fields rather than
   * `JSON.stringify`-ing the whole thing.
   */
  override readonly cause?: unknown;

  constructor(
    code: FilesErrorCode,
    message: string,
    cause?: unknown,
    opts?: {
      aborted?: boolean;
      timedOut?: boolean;
      permanent?: boolean;
      applied?: boolean;
      appliedEtag?: string;
    }
  ) {
    super(message);
    this.name = "FilesError";
    this.code = code;
    this.aborted = opts?.aborted === true;
    this.timedOut = opts?.timedOut === true;
    this.permanent = opts?.permanent === true;
    this.applied = opts?.applied === true;
    if (opts?.appliedEtag !== undefined) {
      this.appliedEtag = opts.appliedEtag;
    }
    this.cause = cause;
  }

  /**
   * Re-raise `cause` as the outcome of a conditional mutation that already
   * committed: same code, message, and flags, with {@link applied} set (and
   * {@link appliedEtag} for uploads). The original error is kept as `cause`
   * so nothing about the failure is lost.
   */
  static applied(cause: unknown, appliedEtag?: string): FilesError {
    const wrapped = FilesError.wrap(cause);
    return new FilesError(wrapped.code, wrapped.message, cause, {
      aborted: wrapped.aborted,
      applied: true,
      ...(appliedEtag !== undefined && { appliedEtag }),
      permanent: wrapped.permanent,
      timedOut: wrapped.timedOut,
    });
  }

  static wrap(
    cause: unknown,
    fallbackCode: FilesErrorCode = "Provider"
  ): FilesError {
    if (cause instanceof FilesError) {
      return cause;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return new FilesError(fallbackCode, message, cause);
  }
}

// Set once on the prototype (not per instance) so subclasses inherit it and it
// stays out of `JSON.stringify`/`Object.keys`. A plain statement rather than a
// `static {}` block keeps ES2022 class syntax out of the browser bundles.
Object.defineProperty(FilesError.prototype, FILES_ERROR_BRAND, { value: true });
