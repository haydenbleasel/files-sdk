// `files-sdk/effect` — an Effect v4 bridge over a `Files` instance. `Files` is
// a `Context.Service` whose operations return `Effect`s (and `Stream`s for
// `listAll`, `search`, download bodies and storage events), fail with a typed
// `FilesError` whose `reason` is the SDK's code, and cancel the provider call
// when their fiber is interrupted: the fiber's `AbortSignal` is passed as the
// call's `signal`.
//
// It wraps an instance rather than reimplementing anything, so adapters,
// plugins, retries, timeouts and hooks behave exactly as they do without it.

// oxlint-disable-next-line max-classes-per-file -- one tagged error class per FilesErrorCode, the FilesError that carries them, and the service
import {
  Context,
  Effect,
  FiberSet,
  Layer,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";

import type {
  EventsExtension,
  EventTypeFilter,
  FilesEvents,
} from "../events/index.js";
import type {
  Adapter,
  AdapterCapabilities,
  Body,
  BulkOptions,
  BulkResult,
  ConditionalUploadOptions,
  ConditionalUploadResult,
  CopyOptions,
  DeleteManyOptions,
  DeleteManyResult,
  DeleteOptions,
  DownloadManyOptions,
  DownloadOptions,
  ExistsManyResult,
  FileInfo,
  FilesOptions,
  HeadManyResult,
  ListOptions,
  ListResult,
  OperationOptions,
  ResumableUploadSession,
  SearchOptions,
  SignedUpload,
  SignUploadOptions,
  StoredFile,
  UploadManyItem,
  UploadManyOptions,
  UploadManyResult,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import { Files as FilesClient } from "../index.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { FilesError as SdkFilesError } from "../internal/errors.js";
import type { FileEvent } from "../internal/events.js";
import { isObject, isString } from "../internal/is.js";
import { combineSignals } from "../internal/retry.js";

export type { FileEvent, FileEventType } from "../internal/events.js";
export type { EventTypeFilter } from "../events/index.js";

// Errors: one tagged `FilesError` whose `reason` is the SDK's code as its own
// tagged error, the shape Effect's own platform and AI errors use. Recover
// from one code with `Effect.catchReason("FilesError", "NotFound", …)`, or
// lift the reasons into the error channel with
// `Effect.unwrapReason("FilesError")`.

const flag = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(value)));

// A reason carries the SDK error's fields. The flags default the way the SDK
// error's constructor does, so a test double only needs `{ message }`.
const reasonClass =
  <Self>() =>
  <const Code extends FilesErrorCode>(code: Code, permanent: boolean) =>
    // oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an error constructor
    Schema.TaggedError<Self>()(code, {
      /** `true` when the operation was aborted (a caller's signal or a `timeout`). */
      aborted: flag(false),
      /** `true` when a conditional mutation committed before the call failed. */
      applied: flag(false),
      /** The committed ETag, when `applied` is set on an upload. */
      appliedEtag: Schema.optional(Schema.String),
      /** The SDK's `FilesError`, with the provider's own error as its `cause`. */
      cause: Schema.optional(Schema.Defect()),
      message: Schema.String,
      /** `true` when retrying the same call can only fail the same way. */
      permanent: flag(permanent),
      /** `true` when a configured `timeout` cut the operation off. */
      timedOut: flag(false),
    });

/** The object or key doesn't exist. */
export class NotFound extends reasonClass<NotFound>()("NotFound", false) {}

/** The provider rejected the credentials or the access they grant. */
export class Unauthorized extends reasonClass<Unauthorized>()(
  "Unauthorized",
  false
) {}

/** A precondition failed: a conditional write lost, or the key already exists. */
export class Conflict extends reasonClass<Conflict>()("Conflict", false) {}

/** A write on a read-only `Files` instance. */
export class ReadOnly extends reasonClass<ReadOnly>()("ReadOnly", true) {}

/** The call itself is wrong: a bad argument, contradictory options, bad config. */
export class Invalid extends reasonClass<Invalid>()("Invalid", true) {}

/** Well-formed, but this adapter (in this mode, with these plugins) can't do it. */
export class Unsupported extends reasonClass<Unsupported>()(
  "Unsupported",
  true
) {}

/** The backend or transport failed. The only code the SDK retries. */
export class Provider extends reasonClass<Provider>()("Provider", false) {}

/** One reason per `FilesErrorCode`, tagged with the code. */
export type FilesErrorReason =
  | NotFound
  | Unauthorized
  | Conflict
  | ReadOnly
  | Invalid
  | Unsupported
  | Provider;

/**
 * Every failure from a `files-sdk/effect` operation. `reason._tag` is the
 * SDK's `FilesErrorCode`; `reason.cause` is the SDK's own `FilesError`.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an error constructor
export class FilesError extends Schema.TaggedError<FilesError>()("FilesError", {
  reason: Schema.Union([
    NotFound,
    Unauthorized,
    Conflict,
    ReadOnly,
    Invalid,
    Unsupported,
    Provider,
  ]),
}) {
  override get message(): string {
    return this.reason.message;
  }
}

const REASONS = {
  Conflict,
  Invalid,
  NotFound,
  Provider,
  ReadOnly,
  Unauthorized,
  Unsupported,
} satisfies {
  readonly [Code in FilesErrorCode]: { readonly prototype: { _tag: Code } };
};

// Anything an SDK call rejected with. A `FilesError` keeps its code and
// flags; anything else becomes a `Provider` failure, the same normalization
// the SDK applies at its own boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason is untyped; this is where it's normalized
const fromCause = (cause: unknown): FilesError => {
  const error = SdkFilesError.wrap(cause);
  const Reason = REASONS[error.code];
  return new FilesError({
    reason: new Reason({
      aborted: error.aborted,
      applied: error.applied,
      ...(error.appliedEtag !== undefined && {
        appliedEtag: error.appliedEtag,
      }),
      cause: error,
      message: error.message,
      permanent: error.permanent,
      timedOut: error.timedOut,
    }),
  });
};

/**
 * A downloaded object: its {@link FileInfo} plus the body as Effect values.
 * `text`, `arrayBuffer` and `blob` buffer the body and can be run more than
 * once; `stream` reads it unbuffered, once, and can't be mixed with them (the
 * same rule as the SDK's `StoredFile`).
 */
export interface DownloadedFile extends FileInfo {
  /** Same as `key` (the `File`-like name). */
  readonly name: string;
  /** Same as `contentType` (the `File`-like MIME type). */
  readonly type: string;
  readonly text: Effect.Effect<string, FilesError>;
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, FilesError>;
  readonly blob: Effect.Effect<Blob, FilesError>;
  /** The body, unbuffered. Interrupting the stream cancels the read. */
  readonly stream: Stream.Stream<Uint8Array, FilesError>;
  /** The SDK's `StoredFile`, for APIs that take a `File`-like (`Response`, `FormData`). */
  readonly file: StoredFile;
}

/** What the array form of `download()` resolves to. */
export type DownloadedManyResult = BulkResult<DownloadedFile>;

/** Handles one storage event. A failure fails the delivery, so the provider redelivers. */
export type FileEventHandler<E, R> = (
  event: FileEvent
) => Effect.Effect<void, E, R>;

/** Options for {@link FileEventsService.stream}. */
export interface FileEventStreamOptions {
  /**
   * Events buffered for a slow consumer before deliveries wait for room.
   * Default 16.
   */
  bufferSize?: number;
}

/**
 * Storage events, for an instance with the `events()` plugin
 * (`files-sdk/events`). Without it, every member fails with `Unsupported`.
 */
export interface FileEventsService {
  /**
   * Run `handler` for events of `type` whose key matches `pattern` (a glob,
   * `**` when omitted), for the lifetime of the current `Scope`. Deliveries
   * wait for the handler, so a failure (or an interruption when the scope
   * closes) fails the delivery and the provider redelivers it: delivery stays
   * at-least-once. Use this to process events durably.
   */
  readonly on: {
    <E = never, R = never>(
      type: EventTypeFilter,
      handler: FileEventHandler<E, R>
    ): Effect.Effect<void, FilesError, R | Scope.Scope>;
    <E = never, R = never>(
      type: EventTypeFilter,
      pattern: string,
      handler: FileEventHandler<E, R>
    ): Effect.Effect<void, FilesError, R | Scope.Scope>;
  };
  /**
   * Events of `type` (default `"*"`) whose key matches `pattern` (default
   * `**`), as a `Stream`. A delivery is acknowledged once its event is
   * buffered, before the consumer processes it, so an event in the buffer when
   * the process stops is lost: use {@link on} when every event must be
   * handled. When the buffer is full, deliveries wait; any still waiting when
   * the stream ends fail, so the provider redelivers them.
   */
  readonly stream: (
    type?: EventTypeFilter,
    pattern?: string,
    options?: FileEventStreamOptions
  ) => Stream.Stream<FileEvent, FilesError>;
  /** `files.events.parse()`: normalize deliveries into events without running handlers. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
  readonly parse: (input: unknown) => Effect.Effect<FileEvent[], FilesError>;
  /** `files.events.dispatch()`: parse, then run the matching handlers. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
  readonly dispatch: (input: unknown) => Effect.Effect<FileEvent[], FilesError>;
}

/**
 * The `Files` service: each `Files` method as an `Effect` (or a `Stream`),
 * failing with {@link FilesError}. Options are the SDK's own; a `signal` you
 * pass still aborts the call alongside the fiber's.
 */
export interface FilesService<F extends FilesClient = FilesClient> {
  /** The wrapped instance, for what the service doesn't cover (`raw`, `prefix`, `file()`). */
  readonly client: F;
  /** `files.capabilities`: what this adapter (and plugin stack) supports. */
  readonly capabilities: AdapterCapabilities;
  readonly upload: {
    (
      key: string,
      body: Body,
      opts: ConditionalUploadOptions
    ): Effect.Effect<ConditionalUploadResult, FilesError>;
    (
      key: string,
      body: Body,
      opts?: UploadOptions
    ): Effect.Effect<UploadResult, FilesError>;
    (
      items: UploadManyItem[],
      opts?: UploadManyOptions
    ): Effect.Effect<UploadManyResult, FilesError>;
  };
  readonly download: {
    (
      key: string,
      opts?: DownloadOptions
    ): Effect.Effect<DownloadedFile, FilesError>;
    (
      keys: string[],
      opts?: DownloadManyOptions
    ): Effect.Effect<DownloadedManyResult, FilesError>;
  };
  readonly head: {
    (key: string, opts?: OperationOptions): Effect.Effect<FileInfo, FilesError>;
    (
      keys: string[],
      opts?: BulkOptions
    ): Effect.Effect<HeadManyResult, FilesError>;
  };
  readonly exists: {
    (key: string, opts?: OperationOptions): Effect.Effect<boolean, FilesError>;
    (
      keys: string[],
      opts?: BulkOptions
    ): Effect.Effect<ExistsManyResult, FilesError>;
  };
  readonly delete: {
    (key: string, opts?: DeleteOptions): Effect.Effect<void, FilesError>;
    (
      keys: string[],
      opts?: DeleteManyOptions
    ): Effect.Effect<DeleteManyResult, FilesError>;
  };
  readonly copy: (
    from: string,
    to: string,
    opts?: CopyOptions
  ) => Effect.Effect<void, FilesError>;
  readonly move: (
    from: string,
    to: string,
    opts?: OperationOptions
  ) => Effect.Effect<void, FilesError>;
  readonly list: (opts?: ListOptions) => Effect.Effect<ListResult, FilesError>;
  /** Every object, page by page. Stopping the stream early stops the walk. */
  readonly listAll: (opts?: ListOptions) => Stream.Stream<FileInfo, FilesError>;
  /** `files.search()`: objects whose key matches `pattern`, as a `Stream`. */
  readonly search: (
    pattern: string | RegExp,
    opts?: SearchOptions
  ) => Stream.Stream<FileInfo, FilesError>;
  readonly url: (
    key: string,
    opts?: UrlOptions
  ) => Effect.Effect<string, FilesError>;
  readonly signedUploadUrl: (
    key: string,
    opts: SignUploadOptions
  ) => Effect.Effect<SignedUpload, FilesError>;
  readonly abortUpload: (
    key: string,
    session: ResumableUploadSession,
    opts?: OperationOptions
  ) => Effect.Effect<void, FilesError>;
  /**
   * Run any call on the wrapped instance (a plugin method, `transfer()`)
   * with the same error mapping as the built-in operations. Pass `signal` to
   * calls that take one, and interrupting the fiber aborts them too.
   */
  readonly tryPromise: <A>(
    run: (client: F, signal: AbortSignal) => PromiseLike<A>
  ) => Effect.Effect<A, FilesError>;
  readonly events: FileEventsService;
}

// The fiber's signal, plus any the caller passed: either one aborts the call.
const withSignal = <O extends OperationOptions>(
  opts: O | undefined,
  signal: AbortSignal
): O => {
  const merged = opts?.signal
    ? (combineSignals([opts.signal, signal]) ?? signal)
    : signal;
  // SAFETY: every SDK option bag is all-optional except `SignUploadOptions`,
  // which `signedUploadUrl` always passes in full, so `{ signal }` alone is a
  // valid `O` and spreading a passed `O` keeps every field it had.
  return { ...opts, signal: merged } as O;
};

const attempt = <A>(
  run: (signal: AbortSignal) => PromiseLike<A>
): Effect.Effect<A, FilesError> =>
  Effect.tryPromise({ catch: fromCause, try: run });

// `Stream.fromAsyncIterable` closes a stopped iterator with `return()`, which
// waits for an in-flight `next()` (a whole `list()` page) to settle. Aborting
// first cuts that page off, so interrupting the stream is prompt.
const abortable = <A>(
  open: (signal: AbortSignal) => AsyncIterable<A>
): AsyncIterable<A> => ({
  [Symbol.asyncIterator]: () => {
    const controller = new AbortController();
    const iterator = open(controller.signal)[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: async () => {
        controller.abort();
        await iterator.return?.();
        return { done: true, value: undefined };
      },
    };
  },
});

const iterate = <A>(
  open: (signal: AbortSignal) => AsyncIterable<A>
): Stream.Stream<A, FilesError> =>
  Stream.fromAsyncIterable(abortable(open), fromCause);

const toDownloadedFile = (file: StoredFile): DownloadedFile => ({
  arrayBuffer: Effect.tryPromise({
    catch: fromCause,
    try: () => file.arrayBuffer(),
  }),
  blob: Effect.tryPromise({ catch: fromCause, try: () => file.blob() }),
  contentType: file.contentType,
  ...(file.etag !== undefined && { etag: file.etag }),
  file,
  key: file.key,
  ...(file.lastModified !== undefined && { lastModified: file.lastModified }),
  ...(file.metadata !== undefined && { metadata: file.metadata }),
  name: file.name,
  size: file.size,
  stream: Stream.unwrap(
    Effect.try({ catch: fromCause, try: () => file.stream() }).pipe(
      Effect.map((readable) =>
        Stream.fromReadableStream({
          evaluate: () => readable,
          onError: fromCause,
        })
      )
    )
  ),
  text: Effect.tryPromise({ catch: fromCause, try: () => file.text() }),
  type: file.type,
});

const hasEvents = (
  client: FilesClient
): client is FilesClient & EventsExtension =>
  "events" in client && isObject(client.events);

const eventsOf = (
  client: FilesClient
): Effect.Effect<FilesEvents, FilesError> =>
  hasEvents(client)
    ? Effect.succeed(client.events)
    : Effect.fail(
        fromCause(
          new SdkFilesError(
            "Unsupported",
            "files-sdk/effect: this Files instance has no storage events; add the events() plugin (files-sdk/events)"
          )
        )
      );

// Register `handler` for the life of the scope. `Effect.try` because `on()`
// throws when a plugin refuses provider events.
const register = (
  events: FilesEvents,
  type: EventTypeFilter,
  pattern: string | undefined,
  handler: (event: FileEvent) => Promise<void>
): Effect.Effect<void, FilesError, Scope.Scope> =>
  Effect.try({
    catch: fromCause,
    try: () =>
      pattern === undefined
        ? events.on(type, handler)
        : events.on(type, pattern, handler),
  }).pipe(Effect.flatMap((off) => Effect.addFinalizer(() => Effect.sync(off))));

const makeEvents = (client: FilesClient): FileEventsService => {
  function on<E, R>(
    type: EventTypeFilter,
    handler: FileEventHandler<E, R>
  ): Effect.Effect<void, FilesError, R | Scope.Scope>;
  function on<E, R>(
    type: EventTypeFilter,
    pattern: string,
    handler: FileEventHandler<E, R>
  ): Effect.Effect<void, FilesError, R | Scope.Scope>;
  function on<E, R>(
    type: EventTypeFilter,
    ...args: [FileEventHandler<E, R>] | [string, FileEventHandler<E, R>]
  ): Effect.Effect<void, FilesError, R | Scope.Scope> {
    const [pattern, handler] = args.length === 1 ? [undefined, ...args] : args;
    return Effect.gen(function* subscribe() {
      const events = yield* eventsOf(client);
      // Handler fibers belong to the scope: closing it interrupts any still
      // running, which fails their deliveries so the provider redelivers.
      const run = yield* FiberSet.makeRuntimePromise<R>();
      yield* register(events, type, pattern, async (event) => {
        await run(handler(event));
      });
    });
  }

  const stream = (
    type: EventTypeFilter = "*",
    pattern?: string,
    options?: FileEventStreamOptions
  ): Stream.Stream<FileEvent, FilesError> =>
    Stream.callback<FileEvent, FilesError>(
      (queue) =>
        Effect.gen(function* feed() {
          const events = yield* eventsOf(client);
          const run = yield* FiberSet.makeRuntimePromise();
          // Resolves once the event is buffered and waits while the buffer is
          // full. When the stream ends, the handler is removed first, then
          // the scope interrupts any delivery still waiting, failing it so
          // the provider redelivers.
          yield* register(events, type, pattern, async (event) => {
            await run(Queue.offer(queue, event));
          });
        }),
      { bufferSize: options?.bufferSize ?? 16, strategy: "suspend" }
    );

  return {
    dispatch: (input) =>
      Effect.flatMap(eventsOf(client), (events) =>
        attempt(() => events.dispatch(input))
      ),
    on,
    parse: (input) =>
      Effect.flatMap(eventsOf(client), (events) =>
        attempt(() => events.parse(input))
      ),
    stream,
  };
};

/**
 * The {@link FilesService} for a `Files` instance. `Files.layer()` covers the
 * common case; call this to provide the service under your own
 * `Context.Service` (one per bucket, or typed with a `createFiles()`
 * instance's plugin methods).
 */
export const make = <F extends FilesClient>(client: F): FilesService<F> => {
  function upload(
    key: string,
    body: Body,
    opts: ConditionalUploadOptions
  ): Effect.Effect<ConditionalUploadResult, FilesError>;
  function upload(
    key: string,
    body: Body,
    opts?: UploadOptions
  ): Effect.Effect<UploadResult, FilesError>;
  function upload(
    items: UploadManyItem[],
    opts?: UploadManyOptions
  ): Effect.Effect<UploadManyResult, FilesError>;
  // The array (bulk) forms take no per-call signal in the SDK, so they run to
  // completion even when their fiber is interrupted.
  function upload(
    keyOrItems: string | UploadManyItem[],
    bodyOrOpts?: Body | UploadManyOptions,
    opts?: UploadOptions
  ): Effect.Effect<UploadResult | UploadManyResult, FilesError> {
    if (isString(keyOrItems)) {
      // SAFETY: the single-object overloads take the body second.
      const body = bodyOrOpts as Body;
      return attempt((signal) =>
        client.upload(keyOrItems, body, withSignal(opts, signal))
      );
    }
    // SAFETY: the array overload takes its options second.
    const manyOpts = bodyOrOpts as UploadManyOptions | undefined;
    return attempt(() => client.upload(keyOrItems, manyOpts));
  }

  function download(
    key: string,
    opts?: DownloadOptions
  ): Effect.Effect<DownloadedFile, FilesError>;
  function download(
    keys: string[],
    opts?: DownloadManyOptions
  ): Effect.Effect<DownloadedManyResult, FilesError>;
  function download(
    keyOrKeys: string | string[],
    opts?: DownloadOptions & DownloadManyOptions
  ): Effect.Effect<DownloadedFile | DownloadedManyResult, FilesError> {
    if (isString(keyOrKeys)) {
      return Effect.map(
        attempt((signal) =>
          client.download(keyOrKeys, withSignal(opts, signal))
        ),
        toDownloadedFile
      );
    }
    return Effect.map(
      attempt(() => client.download(keyOrKeys, opts)),
      (result) => ({ ...result, results: result.results.map(toDownloadedFile) })
    );
  }

  function head(
    key: string,
    opts?: OperationOptions
  ): Effect.Effect<FileInfo, FilesError>;
  function head(
    keys: string[],
    opts?: BulkOptions
  ): Effect.Effect<HeadManyResult, FilesError>;
  function head(
    keyOrKeys: string | string[],
    opts?: OperationOptions & BulkOptions
  ): Effect.Effect<FileInfo | HeadManyResult, FilesError> {
    return isString(keyOrKeys)
      ? attempt((signal) => client.head(keyOrKeys, withSignal(opts, signal)))
      : attempt(() => client.head(keyOrKeys, opts));
  }

  function exists(
    key: string,
    opts?: OperationOptions
  ): Effect.Effect<boolean, FilesError>;
  function exists(
    keys: string[],
    opts?: BulkOptions
  ): Effect.Effect<ExistsManyResult, FilesError>;
  function exists(
    keyOrKeys: string | string[],
    opts?: OperationOptions & BulkOptions
  ): Effect.Effect<boolean | ExistsManyResult, FilesError> {
    return isString(keyOrKeys)
      ? attempt((signal) => client.exists(keyOrKeys, withSignal(opts, signal)))
      : attempt(() => client.exists(keyOrKeys, opts));
  }

  function remove(
    key: string,
    opts?: DeleteOptions
  ): Effect.Effect<void, FilesError>;
  function remove(
    keys: string[],
    opts?: DeleteManyOptions
  ): Effect.Effect<DeleteManyResult, FilesError>;
  function remove(
    keyOrKeys: string | string[],
    opts?: DeleteOptions & DeleteManyOptions
  ): Effect.Effect<void | DeleteManyResult, FilesError> {
    return isString(keyOrKeys)
      ? attempt((signal) => client.delete(keyOrKeys, withSignal(opts, signal)))
      : attempt(() => client.delete(keyOrKeys, opts));
  }

  return {
    abortUpload: (key, session, opts) =>
      attempt((signal) =>
        client.abortUpload(key, session, withSignal(opts, signal))
      ),
    get capabilities() {
      return client.capabilities;
    },
    client,
    copy: (from, to, opts) =>
      attempt((signal) => client.copy(from, to, withSignal(opts, signal))),
    delete: remove,
    download,
    events: makeEvents(client),
    exists,
    head,
    list: (opts) => attempt((signal) => client.list(withSignal(opts, signal))),
    listAll: (opts) =>
      iterate((signal) => client.listAll(withSignal(opts, signal))),
    move: (from, to, opts) =>
      attempt((signal) => client.move(from, to, withSignal(opts, signal))),
    search: (pattern, opts) =>
      iterate((signal) => client.search(pattern, withSignal(opts, signal))),
    signedUploadUrl: (key, opts) =>
      attempt((signal) =>
        client.signedUploadUrl(key, withSignal(opts, signal))
      ),
    tryPromise: (run) => attempt((signal) => run(client, signal)),
    upload,
    url: (key, opts) =>
      attempt((signal) => client.url(key, withSignal(opts, signal))),
  };
};

/**
 * The `Files` service. Provide it with {@link Files.layer}, then
 * `yield* Files` to get the {@link FilesService}.
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const files = yield* Files;
 *   yield* files.upload("hello.txt", "Hello");
 * });
 * program.pipe(Effect.provide(Files.layer({ adapter: s3() })));
 * ```
 */
export class Files extends Context.Service<Files, FilesService>()(
  "files-sdk/effect/Files"
) {
  /**
   * Provide {@link Files} from a `Files` instance, or from the options to
   * construct one (invalid options fail the layer with `Invalid`).
   */
  static readonly layer = <A extends Adapter>(
    clientOrOptions: FilesClient | FilesOptions<A>
  ): Layer.Layer<Files, FilesError> =>
    Layer.effect(
      Files,
      Effect.try({
        catch: fromCause,
        try: () =>
          make(
            "upload" in clientOrOptions
              ? clientOrOptions
              : new FilesClient(clientOrOptions)
          ),
      })
    );
}
