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
    opts?: { aborted?: boolean }
  ) {
    super(message);
    this.name = "FilesError";
    this.code = code;
    this.aborted = opts?.aborted === true;
    this.cause = cause;
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
