// Pause-able / resumable uploads.
//
// `upload()` is single-shot; this module adds a control handle (`UploadControl`,
// an AbortSignal-style object) that callers pass into `upload()` to pause,
// resume, abort, and — via a serializable session token — resume across
// processes after a crash or page reload.
//
// The hard parts (chunk slicing, parallel-vs-sequential dispatch, pause gating,
// per-chunk retry, progress, token wiring) live here in a provider-agnostic
// orchestrator. Each capable adapter only implements a thin {@link
// ResumableDriver} of wire calls. Adapters never touch `UploadControl`; the
// orchestrator mediates, reading and writing the control's private state
// through a module-scoped `WeakMap`.

import type {
  Body,
  MultipartOptions,
  RetryOptions,
  UploadProgress,
  UploadResult,
} from "../index.js";
import { FilesError } from "./errors.js";
import {
  abortError,
  canRetry,
  maxRetries,
  mergeSignals,
  retryBackoff,
  runWithSignal,
  sleep,
} from "./retry.js";

// =============================================================================
// Serializable session token
// =============================================================================

/**
 * A serializable handle to a provider-side upload session, discriminated by
 * provider family. Produced by {@link UploadControl.toJSON} once a session is
 * established; persist it (disk, `localStorage`, a DB) and rehydrate it with
 * {@link UploadControl.from} to resume the upload in a later process.
 *
 * The shape differs per provider because the resume primitive does: S3 and
 * Azure track discrete parts/blocks (so the part size is pinned in the token —
 * resumed part boundaries must line up), while GCS, OneDrive, and Dropbox track
 * a byte offset against an opaque session URL/id.
 */
export type ResumableUploadSession =
  | {
      provider: "s3";
      bucket: string;
      key: string;
      uploadId: string;
      partSize: number;
    }
  | { provider: "gcs"; bucket: string; key: string; uri: string }
  | { provider: "google-drive"; key: string; uri: string }
  | {
      provider: "azure";
      container: string;
      blob: string;
      blockSize: number;
      contentType: string;
    }
  | { provider: "onedrive"; itemPath: string; uploadUrl: string }
  | {
      provider: "dropbox";
      path: string;
      sessionId: string;
      offset: number;
      contentType: string;
    }
  | {
      provider: "vercel-blob";
      key: string;
      storageKey: string;
      uploadId: string;
      partSize: number;
      contentType: string;
      // Vercel Blob exposes no "list parts", so completed parts are tracked
      // in the token itself (the driver appends to this as each part lands).
      parts: PartMeta[];
    }
  | { provider: "fs"; key: string; tempPath: string; contentType: string }
  | { provider: "memory"; key: string; uploadId: string; contentType: string }
  | { provider: "ftp"; key: string }
  | { provider: "sftp"; key: string }
  | { provider: "bun-s3"; key: string; uploadId: string; contentType: string }
  | { provider: "supabase"; key: string; uri: string; contentType: string }
  | {
      provider: "appwrite";
      key: string;
      fileId: string;
      contentType: string;
      offset: number;
    }
  | {
      provider: "cloudinary";
      key: string;
      uploadId: string;
      contentType: string;
      offset: number;
    }
  | { provider: "box"; key: string; uploadId: string; contentType: string };

/** The lifecycle state of an {@link UploadControl}. */
export type UploadControlStatus =
  | "idle"
  | "uploading"
  | "paused"
  | "completed"
  | "aborted"
  | "error";

// =============================================================================
// UploadControl
// =============================================================================

interface ControlInternals {
  status: UploadControlStatus;
  loaded: number;
  total?: number;
  session?: ResumableUploadSession;
  paused: boolean;
  resumeWaiters: (() => void)[];
  abortController: AbortController;
  /** Set by the orchestrator once a provider session exists; discards it. */
  discard?: () => Promise<void>;
  /** One control drives at most one upload. */
  consumed: boolean;
}

// Private state lives off-instance so the orchestrator (this module) can read
// and mutate it without exposing setters on the public class.
const internals = new WeakMap<UploadControl, ControlInternals>();

const stateOf = (control: UploadControl): ControlInternals =>
  // Only ever called with controls this module constructed, so the entry
  // always exists.
  internals.get(control) as ControlInternals;

/**
 * A handle for pausing, resuming, aborting, and serializing a single
 * {@link UploadOptions.control resumable upload}. Construct one and pass it to
 * `upload()`; the SDK populates {@link session} as soon as the provider session
 * is created, so `pause()` then `toJSON()` captures resumable state even before
 * the first chunk lands.
 *
 * A control drives one upload. To resume in a new process, persist
 * `toJSON()` and rehydrate with {@link UploadControl.from}.
 */
export class UploadControl {
  constructor() {
    internals.set(this, {
      abortController: new AbortController(),
      consumed: false,
      loaded: 0,
      paused: false,
      resumeWaiters: [],
      status: "idle",
    });
  }

  /**
   * Rebuild a control pre-loaded with a persisted {@link toJSON} token, ready
   * to resume. Pass it to `upload()` with the same body — the SDK discovers
   * what already landed server-side and uploads only the rest.
   */
  static from(session: ResumableUploadSession): UploadControl {
    const control = new UploadControl();
    stateOf(control).session = session;
    return control;
  }

  /** Lifecycle state — see {@link UploadControlStatus}. */
  get status(): UploadControlStatus {
    return stateOf(this).status;
  }

  /** Cumulative bytes confirmed uploaded so far. */
  get loaded(): number {
    return stateOf(this).loaded;
  }

  /** Total bytes to upload, once known. */
  get total(): number | undefined {
    return stateOf(this).total;
  }

  /** The current session token, or `undefined` before one is established. */
  get session(): ResumableUploadSession | undefined {
    return stateOf(this).session;
  }

  /** The session token to persist for a later {@link UploadControl.from} resume. */
  toJSON(): ResumableUploadSession | undefined {
    return stateOf(this).session;
  }

  /**
   * Stop dispatching new chunks. In-flight chunks settle; the `upload()`
   * promise stays pending until {@link resume}. The session is preserved, so
   * you can `toJSON()` and persist it here.
   */
  pause(): void {
    const state = stateOf(this);
    if (state.status === "completed" || state.status === "aborted") {
      return;
    }
    state.paused = true;
    if (state.status === "uploading") {
      state.status = "paused";
    }
  }

  /** Continue a paused upload. */
  resume(): void {
    const state = stateOf(this);
    if (!state.paused) {
      return;
    }
    state.paused = false;
    if (state.status === "paused") {
      state.status = "uploading";
    }
    const waiters = state.resumeWaiters;
    state.resumeWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /**
   * Cancel the upload **and** discard the provider-side session (a partial
   * upload left behind by `pause()` can be billed/retained by the provider).
   * The `upload()` promise rejects with an aborted {@link FilesError}. Terminal:
   * the session can no longer be resumed.
   *
   * To cancel but *keep* the session for a later resume, abort via
   * {@link OperationOptions.signal} instead.
   */
  async abort(reason?: unknown): Promise<void> {
    const state = stateOf(this);
    if (state.status === "completed" || state.status === "aborted") {
      return;
    }
    state.status = "aborted";
    state.paused = false;
    const waiters = state.resumeWaiters;
    state.resumeWaiters = [];
    for (const wake of waiters) {
      wake();
    }
    state.abortController.abort(abortError(reason));
    if (state.discard) {
      try {
        await state.discard();
      } catch {
        // Best-effort cleanup — the upload is already cancelled.
      }
    }
    state.session = undefined;
  }
}

// =============================================================================
// Driver contract (adapter side)
// =============================================================================

/** A completed part/block, tracked so the upload can be finalized. */
export interface PartMeta {
  partNumber: number;
  size: number;
  /** Entity tag, where the provider returns one per part (S3). */
  etag?: string;
}

/** Per-upload knobs an adapter's {@link Adapter.resumableUpload} receives. */
export interface ResumableDriverOptions {
  multipart?: boolean | MultipartOptions;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

interface ResumableDriverBase {
  /**
   * Bytes per part/chunk, finalized by {@link begin} / {@link adopt}. Pinned in
   * the token for part-based providers so resumed boundaries line up.
   */
  readonly partSize: number;
  /** Create the provider session and return its serializable token. */
  begin: (meta: {
    total: number;
    contentType: string;
  }) => Promise<ResumableUploadSession>;
  /** Resume: load (and validate) a persisted token. Throws on a mismatch. */
  adopt: (session: ResumableUploadSession) => void;
  /** Finalize the upload into an {@link UploadResult}. */
  complete: (parts: PartMeta[]) => Promise<UploadResult>;
  /** Discard the provider session and any uploaded-but-uncommitted data. */
  discard: () => Promise<void>;
}

/** Parallel, part-numbered providers (S3, Azure block blobs). */
export interface PartsResumableDriver extends ResumableDriverBase {
  readonly mode: "parts";
  /** Discover which parts already landed server-side (for resume). */
  probe: () => Promise<{ committedParts: PartMeta[] }>;
  uploadPart: (part: {
    partNumber: number;
    data: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<PartMeta>;
}

/** Sequential, offset-based providers (GCS, OneDrive, Dropbox). */
export interface OffsetResumableDriver extends ResumableDriverBase {
  readonly mode: "offset";
  /** Discover the next byte the server expects (for resume). */
  probe: () => Promise<{ nextOffset: number }>;
  uploadAt: (chunk: {
    offset: number;
    data: Uint8Array;
    isLast: boolean;
    total: number;
    signal?: AbortSignal;
  }) => Promise<{ nextOffset: number }>;
}

export type ResumableDriver = PartsResumableDriver | OffsetResumableDriver;

// =============================================================================
// Byte source — slice a buffered body by offset, lazily for Blobs
// =============================================================================

interface ByteSource {
  readonly size: number;
  slice: (start: number, end: number) => Promise<Uint8Array>;
}

const STREAM_BODY_MESSAGE =
  "Pausable/resumable uploads require a body with a known length (File, Blob, ArrayBuffer, typed array, or string), not a ReadableStream — a stream can't be re-read to resume.";

const bufferSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  slice: (start, end) => Promise.resolve(bytes.subarray(start, end)),
});

/**
 * Wrap a {@link Body} so the orchestrator can read any `[start, end)` slice.
 * Buffered bodies slice synchronously; `Blob`/`File` slice lazily so only the
 * parts in flight are held in memory. A `ReadableStream` is rejected — it can't
 * be re-read, which both pause/resume and cross-process resume require.
 */
export const toByteSource = (body: Body): ByteSource => {
  if (typeof body === "string") {
    return bufferSource(new TextEncoder().encode(body));
  }
  if (body instanceof Uint8Array) {
    return bufferSource(body);
  }
  if (body instanceof ArrayBuffer) {
    return bufferSource(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return bufferSource(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    );
  }
  if (body instanceof Blob) {
    return {
      size: body.size,
      async slice(start, end) {
        return new Uint8Array(await body.slice(start, end).arrayBuffer());
      },
    };
  }
  throw new FilesError("Provider", STREAM_BODY_MESSAGE);
};

const inferContentType = (body: Body, hint?: string): string => {
  if (hint) {
    return hint;
  }
  if (typeof body === "string") {
    return "text/plain; charset=utf-8";
  }
  if (body instanceof Blob && body.type) {
    return body.type;
  }
  return "application/octet-stream";
};

// =============================================================================
// Orchestrator
// =============================================================================

export interface RunResumableOptions {
  driver: ResumableDriver;
  body: Body;
  control: UploadControl;
  multipart?: boolean | MultipartOptions;
  onProgress?: (progress: UploadProgress) => void;
  retries?: RetryOptions;
  timeout?: number;
  /** External abort signals (client default + per-call). */
  signals: AbortSignal[];
  contentTypeHint?: string;
}

const DEFAULT_CONCURRENCY = 4;

const resolveConcurrency = (
  multipart: boolean | MultipartOptions | undefined
): number => {
  const concurrency =
    typeof multipart === "object" ? multipart.concurrency : undefined;
  return concurrency && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY;
};

const reportProgress = (
  onProgress: ((progress: UploadProgress) => void) | undefined,
  progress: UploadProgress
): void => {
  if (!onProgress) {
    return;
  }
  try {
    onProgress(progress);
  } catch {
    // Progress is fire-and-forget — a throwing reporter can't fail the upload.
  }
};

/**
 * Block while paused; throw if aborted. Checked before each chunk dispatch.
 * `runSignal` is the run-scoped failure latch: when a sibling worker's part
 * fails permanently, parked workers must wake up and bail instead of waiting
 * for a `resume()` that would march them into a dead run — and must not
 * clobber the control's terminal status back to `"uploading"` on the way out.
 */
const pauseGate = async (
  state: ControlInternals,
  runSignal?: AbortSignal
): Promise<void> => {
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `runSignal.aborted` flips externally (sibling worker failure), not in the loop body.
  while (state.paused && state.status !== "aborted" && !runSignal?.aborted) {
    state.status = "paused";
    // oxlint-disable-next-line promise/avoid-new, no-await-in-loop -- resolved by resume()/abort(); blocks until then, so the await must stay in the loop.
    await new Promise<void>((resolve) => {
      state.resumeWaiters.push(resolve);
      runSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  if (state.status === "aborted") {
    throw abortError(state.abortController.signal.reason);
  }
  if (runSignal?.aborted) {
    return;
  }
  state.status = "uploading";
};

/** Run a single chunk's provider call with per-attempt timeout + retry. */
const attempt = async <T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  opts: RunResumableOptions,
  signals: AbortSignal[]
): Promise<T> => {
  const max = maxRetries(opts.retries, true);
  for (let n = 0; ; n += 1) {
    const runtime = mergeSignals(signals, opts.timeout);
    try {
      // eslint-disable-next-line no-await-in-loop -- retry loop: each attempt must resolve before deciding to retry.
      return await runWithSignal(runtime.signal, () => fn(runtime.signal));
    } catch (error) {
      const wrapped = runtime.signal?.aborted
        ? abortError(runtime.signal.reason)
        : FilesError.wrap(error);
      if (!canRetry(wrapped, n, max)) {
        throw wrapped;
      }
      const wait = mergeSignals(signals);
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential backoff between retry attempts.
        await sleep(retryBackoff(opts.retries, n + 1, wrapped), wait.signal);
      } finally {
        wait.cleanup?.();
      }
    } finally {
      runtime.cleanup?.();
    }
  }
};

const runParts = async (
  driver: PartsResumableDriver,
  source: ByteSource,
  state: ControlInternals,
  committed: PartMeta[],
  opts: RunResumableOptions,
  signals: AbortSignal[]
): Promise<UploadResult> => {
  const { partSize } = driver;
  const total = source.size;
  const numParts = Math.max(1, Math.ceil(total / partSize));
  const committedByNumber = new Map(committed.map((p) => [p.partNumber, p]));
  const results: PartMeta[] = [...committed];

  let loaded = committed.reduce((sum, p) => sum + p.size, 0);
  state.loaded = loaded;
  reportProgress(opts.onProgress, { loaded, total });

  let next = 1;
  // The first part to fail permanently fails the whole run. Without a shared
  // latch, `upload()` would reject while the sibling workers kept slicing and
  // uploading every remaining part in the background (and a later `resume()`
  // could wake paused workers into the dead run). The latch stops new
  // dispatches; the run-scoped abort cancels in-flight sibling attempts.
  let failure: FilesError | undefined;
  const runAbort = new AbortController();
  const workerSignals = [...signals, runAbort.signal];
  const worker = async (): Promise<void> => {
    for (;;) {
      let partNumber: number | undefined;
      while (next <= numParts) {
        const candidate = next;
        next += 1;
        if (!committedByNumber.has(candidate)) {
          partNumber = candidate;
          break;
        }
      }
      if (partNumber === undefined) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop -- worker drains parts serially; concurrency comes from multiple workers.
      await pauseGate(state, runAbort.signal);
      if (failure !== undefined) {
        return;
      }
      const start = (partNumber - 1) * partSize;
      try {
        // eslint-disable-next-line no-await-in-loop -- slice each part before uploading it, within this worker's serial loop.
        const data = await source.slice(
          start,
          Math.min(start + partSize, total)
        );
        // eslint-disable-next-line no-await-in-loop -- upload each part before advancing this worker to the next.
        const meta = await attempt(
          (signal) =>
            driver.uploadPart({
              data,
              partNumber: partNumber as number,
              ...(signal && { signal }),
            }),
          opts,
          workerSignals
        );
        results.push(meta);
        loaded += data.byteLength;
        state.loaded = loaded;
        reportProgress(opts.onProgress, { loaded, total });
      } catch (error) {
        failure ??= FilesError.wrap(error);
        runAbort.abort();
        return;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(resolveConcurrency(opts.multipart), numParts) },
      worker
    )
  );
  if (failure !== undefined) {
    // oxlint-disable-next-line eslint/no-throw-literal -- always a FilesError, wrapped in the worker catch.
    throw failure;
  }
  results.sort((a, b) => a.partNumber - b.partNumber);
  return driver.complete(results);
};

const runOffset = async (
  driver: OffsetResumableDriver,
  source: ByteSource,
  state: ControlInternals,
  startOffset: number,
  opts: RunResumableOptions,
  signals: AbortSignal[]
): Promise<UploadResult> => {
  const chunkSize = driver.partSize;
  const total = source.size;

  if (total === 0) {
    await pauseGate(state);
    await attempt(
      (signal) =>
        driver.uploadAt({
          data: new Uint8Array(),
          isLast: true,
          offset: 0,
          total: 0,
          ...(signal && { signal }),
        }),
      opts,
      signals
    );
    return driver.complete([]);
  }

  // Clamp: a probe of a session that already finalized server-side reports a
  // sentinel offset past the end (the HTTP driver uses MAX_SAFE_INTEGER), and
  // progress must never report more than `total` loaded.
  let offset = Math.min(startOffset, total);
  state.loaded = offset;
  reportProgress(opts.onProgress, { loaded: offset, total });
  while (offset < total) {
    // eslint-disable-next-line no-await-in-loop -- chunks are offset-chained; each depends on the prior nextOffset.
    await pauseGate(state);
    const end = Math.min(offset + chunkSize, total);
    // eslint-disable-next-line no-await-in-loop -- slice the current chunk before uploading it.
    const data = await source.slice(offset, end);
    const isLast = end >= total;
    const current = offset;
    // eslint-disable-next-line no-await-in-loop -- sequential offset upload; nextOffset drives the next iteration.
    const { nextOffset } = await attempt(
      (signal) =>
        driver.uploadAt({
          data,
          isLast,
          offset: current,
          total,
          ...(signal && { signal }),
        }),
      opts,
      signals
    );
    offset = nextOffset;
    state.loaded = offset;
    reportProgress(opts.onProgress, { loaded: offset, total });
  }
  return driver.complete([]);
};

/**
 * Drive a {@link ResumableDriver} to completion under an {@link UploadControl}:
 * establish (or resume) the session, slice and dispatch chunks honoring
 * pause/abort, retry per chunk, report progress, and finalize. Returns the
 * provider's {@link UploadResult}.
 */
export const runResumableUpload = async (
  opts: RunResumableOptions
): Promise<UploadResult> => {
  const state = stateOf(opts.control);
  if (state.consumed) {
    throw new FilesError(
      "Provider",
      "This UploadControl has already driven an upload. Use a fresh UploadControl (or UploadControl.from(token)) per upload."
    );
  }
  state.consumed = true;
  if (state.status === "aborted") {
    throw abortError(state.abortController.signal.reason);
  }

  const source = toByteSource(opts.body);
  const total = source.size;
  state.total = total;
  const { driver } = opts;

  let committedParts: PartMeta[] = [];
  let nextOffset = 0;
  try {
    if (state.session) {
      driver.adopt(state.session);
      // Each branch calls `probe()` separately on purpose: its return type is
      // discriminated by `driver.mode`, so hoisting the call would widen it to
      // a union and lose the narrowing.
      // oxlint-disable-next-line oxc/branches-sharing-code -- see above.
      if (driver.mode === "parts") {
        const probed = await driver.probe();
        ({ committedParts } = probed);
      } else {
        const probed = await driver.probe();
        ({ nextOffset } = probed);
      }
    } else {
      state.session = await driver.begin({
        contentType: inferContentType(opts.body, opts.contentTypeHint),
        total,
      });
    }

    state.discard = () => driver.discard();
    // `abort()` may have raced `begin()`/`probe()`: it found no `state.discard`
    // installed yet (so nothing was cleaned up) and cleared the session — and
    // the assignments above just re-populated both on an aborted control,
    // resurrecting a live token and leaking the provider-side session (e.g. a
    // billed S3 multipart upload). Honor abort()'s terminal contract here.
    // (The controller's signal only aborts via `control.abort()`, never via
    // an external `opts.signals` entry.)
    if (state.abortController.signal.aborted) {
      try {
        await driver.discard();
      } catch {
        // Best-effort cleanup — the upload is already cancelled.
      }
      state.discard = undefined;
      state.session = undefined;
      throw abortError(state.abortController.signal.reason);
    }
    const signals = [state.abortController.signal, ...opts.signals];

    const result =
      driver.mode === "parts"
        ? await runParts(driver, source, state, committedParts, opts, signals)
        : await runOffset(driver, source, state, nextOffset, opts, signals);

    state.status = "completed";
    state.loaded = total;
    reportProgress(opts.onProgress, { loaded: total, total });
    return result;
  } catch (error) {
    const wrapped = FilesError.wrap(error);
    // `control.abort()` aborts this controller and already set status to
    // "aborted"; any other failure (a provider error, or an external
    // `signal` abort that preserves the session for resume) is an error.
    if (!state.abortController.signal.aborted) {
      state.status = "error";
    }
    throw wrapped;
  }
};
