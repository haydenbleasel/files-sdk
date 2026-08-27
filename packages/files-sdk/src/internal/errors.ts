export type FilesErrorCode =
  | "NotFound"
  | "Unauthorized"
  | "Conflict"
  | "ReadOnly"
  | "Provider";

export type ProviderFilesErrorCode = Exclude<FilesErrorCode, "ReadOnly">;

export class FilesError extends Error {
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
   * Re-raise `err` as the outcome of a conditional mutation that already
   * committed: same code, message, and flags, with {@link applied} set (and
   * {@link appliedEtag} for uploads). The original error is kept as `cause`
   * so nothing about the failure is lost.
   */
  static applied(err: unknown, appliedEtag?: string): FilesError {
    const wrapped = FilesError.wrap(err);
    return new FilesError(wrapped.code, wrapped.message, err, {
      aborted: wrapped.aborted,
      applied: true,
      ...(appliedEtag !== undefined && { appliedEtag }),
      permanent: wrapped.permanent,
      timedOut: wrapped.timedOut,
    });
  }

  static wrap(
    err: unknown,
    fallbackCode: FilesErrorCode = "Provider"
  ): FilesError {
    if (err instanceof FilesError) {
      return err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return new FilesError(fallbackCode, message, err);
  }
}
