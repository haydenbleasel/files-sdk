import { Files } from "../index.js";
import type {
  Adapter,
  Body,
  DownloadOptions,
  FilesOperation,
  FilesPlugin,
  ListOptions,
  ListResult,
  OperationOptions,
  PluginNext,
  SignedUpload,
  SignUploadOptions,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import { FilesError } from "../internal/errors.js";

/**
 * Decide whether a failed backend should fail over to the next one. Receives the
 * error normalized to a {@link FilesError} (so `code` and `aborted` are always
 * available) and returns `true` to try the next backend, `false` to surface the
 * error as-is.
 *
 * The default ({@link defaultShouldFailover}) fails over **only** on `Provider`
 * errors — network failures, timeouts (`timedOut`), and 5xx, i.e. "the backend
 * is down" — and never on a caller-aborted request. A `NotFound` / `Unauthorized` / `Conflict` /
 * `ReadOnly` is a *definitive answer from a healthy backend*, so it's surfaced
 * rather than masked by probing a replica. Pass your own to widen this (e.g.
 * also fail over on `NotFound` to read through to a replica) or narrow it.
 */
export type ShouldFailover = (error: FilesError) => boolean;

/**
 * Reported (fire-and-forget) each time an operation fails over from one backend
 * to the next. Lightweight and caller-facing by design — it carries indices into
 * the `[primary, ...secondaries]` chain, never an internal prefixed path. Throwing
 * from the handler is swallowed, so it can't break the operation.
 */
export interface FailoverEvent {
  /** Which verb failed over. */
  operation: FilesOperation["kind"];
  /**
   * Index of the backend that just errored, into `[primary, ...secondaries]` —
   * `0` is the primary, `1` the first secondary, and so on.
   */
  failed: number;
  /** Index of the backend being tried next. */
  next: number;
  /** The error (normalized) that triggered the failover. */
  error: FilesError;
}

export interface FailoverOptions {
  /**
   * The backup adapter(s) to fall back to, tried in order after the primary. A
   * single {@link Adapter} or an array — pass several for a multi-region failover
   * chain. Each is driven through its own internal {@link Files} (so it gets the
   * same retry, capability gating, and `StoredFile` normalization the primary
   * does) and receives **caller-facing keys** — the instance `prefix` is **not**
   * applied to it, so give each secondary its own bucket / container (or avoid a
   * client `prefix` on a failover instance).
   */
  secondaries: Adapter | Adapter[];
  /**
   * Decide whether a backend's error should trigger a fail over to the next one.
   * Defaults to {@link defaultShouldFailover} — fail over only on `Provider`
   * errors (network / timeout / 5xx), never on an aborted request or a
   * definitive answer (`NotFound`, `Unauthorized`, …). See {@link ShouldFailover}.
   */
  shouldFailover?: ShouldFailover;
  /**
   * Called (fire-and-forget) whenever an operation fails over to the next
   * backend — wire it to your metrics / alerting to learn a backend is degraded.
   * A throw from it is swallowed. See {@link FailoverEvent}.
   */
  onFailover?: (event: FailoverEvent) => void;
}

/**
 * The slice of the {@link Files} surface the failover engine drives on each
 * backend. The primary supplies these by re-routing through the plugin `next`
 * (so it keeps the rest of the onion, the instance `prefix`, and the `#run`
 * retry loop); each secondary supplies them from its own {@link Files} instance.
 */
interface BackendRunner {
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  url(key: string, opts?: UrlOptions): Promise<string>;
  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  delete(key: string, opts?: OperationOptions): Promise<void>;
  copy(from: string, to: string, opts?: OperationOptions): Promise<void>;
  move(from: string, to: string, opts?: OperationOptions): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload>;
}

/** Compose a {@link BackendRunner} from a {@link Files} instance (a secondary). */
const runnerFor = (files: Files): BackendRunner => ({
  copy: (from, to, opts) => files.copy(from, to, opts),
  delete: (key, opts) => files.delete(key, opts) as Promise<void>,
  download: (key, opts) => files.download(key, opts),
  exists: (key, opts) => files.exists(key, opts),
  head: (key, opts) => files.head(key, opts),
  list: (opts) => files.list(opts),
  move: (from, to, opts) => files.move(from, to, opts),
  signedUploadUrl: (key, opts) => files.signedUploadUrl(key, opts),
  upload: (key, body, opts) => files.upload(key, body, opts),
  url: (key, opts) => files.url(key, opts),
});

/**
 * Compose a {@link BackendRunner} for the primary from the plugin `next`. Each
 * verb rebuilds its {@link FilesOperation} and continues inward, so the primary
 * keeps the rest of the onion, the instance `prefix`, and the `#run` retry loop.
 */
const runnerViaNext = (next: PluginNext): BackendRunner => ({
  copy: (from, to, options) => next({ from, kind: "copy", options, to }),
  delete: (key, options) => next({ key, kind: "delete", options }),
  download: (key, options) => next({ key, kind: "download", options }),
  exists: (key, options) => next({ key, kind: "exists", options }),
  head: (key, options) => next({ key, kind: "head", options }),
  list: (options) => next({ kind: "list", options }),
  move: (from, to, options) => next({ from, kind: "move", options, to }),
  signedUploadUrl: (key, options) =>
    next({ key, kind: "signedUploadUrl", options }),
  upload: (key, body, options) => next({ body, key, kind: "upload", options }),
  url: (key, options) => next({ key, kind: "url", options }),
});

/**
 * Whether a body can be sent to a second backend after the first consumed it. A
 * `ReadableStream` is read-once — replaying it across backends is impossible — so
 * a streaming upload can't fail over and runs against the primary alone. Every
 * other body (string / `Blob` / `File` / `ArrayBuffer` / typed array) re-reads.
 */
const isReplayable = (body: Body): boolean => !(body instanceof ReadableStream);

/**
 * Fail over only when a backend is *down*, never on a definitive answer. A
 * timeout sets `aborted` too (the attempt was cancelled), but it's the
 * canonical "backend hung" signal this plugin exists for — so `timedOut`
 * overrides the abort exclusion, which is only meant for the caller's own
 * signal.
 */
const defaultShouldFailover: ShouldFailover = (error) =>
  error.code === "Provider" && (!error.aborted || error.timedOut);

const normalizeSecondaries = (
  secondaries: Adapter | Adapter[] | undefined
): Adapter[] => {
  if (secondaries === undefined) {
    return [];
  }
  return Array.isArray(secondaries) ? secondaries : [secondaries];
};

/**
 * Read/write the primary and **fall back to one or more secondary adapters when
 * a backend is down** — a live, per-operation failover chain. The **primary** is
 * the instance's own adapter (reached through the rest of the onion, so it keeps
 * retry and prefixing); the **secondaries** are backup adapters passed in
 * {@link FailoverOptions.secondaries}, tried in order.
 *
 * Every verb runs the same way: try the primary; if it throws and
 * {@link FailoverOptions.shouldFailover} says so (by default, only on a
 * `Provider` error — network / timeout / 5xx), try the next backend, and so on.
 * The first backend that succeeds wins; if the chain is exhausted, the last
 * error is thrown. A definitive answer from a healthy backend (`NotFound`,
 * `Unauthorized`, an aborted request) is **not** failed over — it's surfaced
 * directly, so a genuine 404 stays a 404 instead of being masked by a replica.
 *
 * This is the **availability** counterpart to `tiering()` (which *partitions*
 * data by key/size) — failover treats each secondary as a full replica of one
 * namespace, so it never splits or merges across backends:
 * - **reads** (`download` / `head` / `exists` / `url` / `list`) return the first
 *   reachable backend's answer; `list` is **not** merged (no composite cursor).
 * - **writes** (`upload` / `delete` / `copy` / `move`) land on the first
 *   reachable backend — it does **not** fan out to every backend (that's
 *   `replication()`); a write that fails over during a primary outage lands only
 *   on the secondary.
 * - **`signedUploadUrl`** signs against the first reachable backend.
 * - a **streaming** `upload` (a `ReadableStream` body) can't be replayed, so it
 *   runs against the primary **alone** and isn't failed over.
 *
 * It's **body-transparent** — never buffers or transforms bytes — and adds no
 * surface (`wrap` only), so it works with plain `new Files({ plugins })`.
 *
 * Placement and prefixes:
 * - Place it **last** (innermost) so body-transforming plugins (`encryption()`,
 *   `compression()`) wrap it and apply to **every** backend.
 * - Secondaries receive caller-facing keys (no instance `prefix`), so give each
 *   its own bucket / container and avoid a client `prefix` on a failover
 *   instance.
 *
 * Consistency: failover buys availability, not convergence. An object written to
 * a secondary while the primary was down is invisible to reads once the primary
 * recovers (reads hit the primary first and it answers `NotFound`). Reconcile
 * with `sync` / `transfer`, keep the replica current with `replication()`, or
 * pass a `shouldFailover` that also fails over on `NotFound` to read through.
 *
 * @param options `{ secondaries, shouldFailover?, onFailover? }` — see
 *   {@link FailoverOptions}.
 * @example
 * ```ts
 * import { Files } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { failover } from "files-sdk/failover";
 *
 * const files = new Files({
 *   adapter: s3({ bucket: "primary", region: "us-east-1" }), // primary
 *   plugins: [
 *     failover({
 *       secondaries: s3({ bucket: "backup", region: "us-west-2" }),
 *       onFailover: ({ operation, failed }) =>
 *         console.warn(`failover: ${operation} fell off backend ${failed}`),
 *     }),
 *   ],
 * });
 *
 * await files.download("report.pdf"); // primary, or the backup if it's down
 * ```
 */
export const failover = (options: FailoverOptions): FilesPlugin => {
  const secondaries = normalizeSecondaries(options?.secondaries);
  if (secondaries.length === 0) {
    throw new FilesError(
      "Provider",
      "failover: at least one secondary adapter is required"
    );
  }
  const shouldFailover = options.shouldFailover ?? defaultShouldFailover;
  const { onFailover } = options;
  const secondaryRunners = secondaries.map((adapter) =>
    runnerFor(new Files({ adapter }))
  );

  const notify = (event: FailoverEvent): void => {
    if (!onFailover) {
      return;
    }
    try {
      onFailover(event);
    } catch {
      // Observability is fire-and-forget — never let a reporting error mask the op.
    }
  };

  /**
   * Try each backend in order, failing over while {@link shouldFailover} allows
   * and a next backend exists. Recursive (not a loop) so there's no unreachable
   * tail and every backend's error is handled the same way.
   */
  const runChain = async <T>(
    op: FilesOperation,
    runners: readonly BackendRunner[],
    run: (runner: BackendRunner) => Promise<T>,
    index = 0
  ): Promise<T> => {
    try {
      return await run(runners[index] as BackendRunner);
    } catch (error) {
      const wrapped = FilesError.wrap(error);
      if (index + 1 >= runners.length || !shouldFailover(wrapped)) {
        throw error;
      }
      notify({
        error: wrapped,
        failed: index,
        next: index + 1,
        operation: op.kind,
      });
      return runChain(op, runners, run, index + 1);
    }
  };

  const uploadFailover = (
    op: Extract<FilesOperation, { kind: "upload" }>,
    runners: readonly BackendRunner[]
  ): Promise<UploadResult> => {
    if (isReplayable(op.body)) {
      return runChain(op, runners, (r) =>
        r.upload(op.key, op.body, op.options)
      );
    }
    // A stream is read-once: hand it to the primary alone and surface its error.
    return (runners[0] as BackendRunner).upload(op.key, op.body, op.options);
  };

  const dispatch = (
    op: FilesOperation,
    runners: readonly BackendRunner[]
  ): Promise<unknown> => {
    switch (op.kind) {
      case "upload": {
        return uploadFailover(op, runners);
      }
      case "download": {
        return runChain(op, runners, (r) => r.download(op.key, op.options));
      }
      case "head": {
        return runChain(op, runners, (r) => r.head(op.key, op.options));
      }
      case "exists": {
        return runChain(op, runners, (r) => r.exists(op.key, op.options));
      }
      case "url": {
        return runChain(op, runners, (r) => r.url(op.key, op.options));
      }
      case "delete": {
        return runChain(op, runners, (r) => r.delete(op.key, op.options));
      }
      case "copy": {
        return runChain(op, runners, (r) => r.copy(op.from, op.to, op.options));
      }
      case "move": {
        return runChain(op, runners, (r) => r.move(op.from, op.to, op.options));
      }
      case "list": {
        return runChain(op, runners, (r) => r.list(op.options));
      }
      default: {
        // signedUploadUrl: sign against the first reachable backend.
        return runChain(op, runners, (r) =>
          r.signedUploadUrl(op.key, op.options as SignUploadOptions)
        );
      }
    }
  };

  const wrap = ((op: FilesOperation, next: PluginNext): Promise<unknown> =>
    dispatch(op, [runnerViaNext(next), ...secondaryRunners])) as NonNullable<
    FilesPlugin["wrap"]
  >;

  return { name: "failover", wrap };
};
