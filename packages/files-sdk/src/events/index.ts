// `files-sdk/events` — one place to react when a file is created or deleted,
// however it got there. Normalizes each provider's bucket notifications (see
// `EVENT_FORMATS`) into one `FileEvent`, routes them to handlers by type and
// key glob, and serves them as a webhook endpoint any gateway binding can
// mount. Gateway upload completions and (opt-in) writes made through the
// instance feed the same handlers.
//
// Delivery is at-least-once and can be out of order on every provider:
// handlers must be idempotent, keyed on `event.id`.

import type {
  Files,
  FilesOperation,
  FilesPlugin,
  OperationResult,
  PluginNext,
  UploadResult,
} from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { FileEvent, FileEventType } from "../internal/events.js";
import { FOLD_PROVIDER_EVENT } from "../internal/events.js";
import { globMatcher } from "../internal/glob.js";
import { isFunction, isString } from "../internal/is.js";
import type { JsonValue } from "../internal/json.js";
import { isJsonObject } from "../internal/json.js";
import type { MemoryNotification } from "../memory/index.js";
import type { Delivery, EventFormat, EventParser } from "./formats/index.js";
import { EVENT_FORMATS, isEventFormat, parserFor } from "./formats/index.js";
import type { EventsWebhookOptions, WebhookHandler } from "./webhook.js";
import { createWebhook } from "./webhook.js";

export type {
  FileEvent,
  FileEventSource,
  FileEventType,
} from "../internal/events.js";
export type { EventFormat } from "./formats/index.js";
export { EVENT_FORMATS } from "./formats/index.js";
export type {
  EventsWebhookOptions,
  GoogleOidcOptions,
  SignatureVerifyOptions,
  SnsVerifyOptions,
  WebhookHandler,
} from "./webhook.js";

/** Handles one event. Await anything that must finish before the delivery is acknowledged. */
export type EventHandler = (event: FileEvent) => void | Promise<void>;

/** Which events a handler receives: one type, or both. */
export type EventTypeFilter = FileEventType | "*";

/**
 * Drops repeated event ids, for handlers that can't be made idempotent. `has`
 * is checked before an event's handlers run; `add` is called once they all
 * succeed (a failed event stays eligible for its redelivery). A `Set`-backed
 * store works in one process; use Redis/KV/a table across instances.
 */
export interface EventDedupeStore {
  has: (id: string) => boolean | Promise<boolean>;
  /** Remember `id` for `ttl` ms. */
  add: (id: string, ttl: number) => void | Promise<void>;
}

export interface EventsOptions {
  /**
   * The notification format `parse()` / `dispatch()` / `webhook()` read.
   * Defaults to the one the adapter declares (`files.capabilities.events`):
   * `"s3"` for `s3` and `s3-fetch` on AWS, `minio`, `rustfs`, `storj` and
   * `wasabi`; `"r2"` for every `r2` engine; `"gcs"` for `gcs` and
   * `firebase-storage`; `"azure"`, `"b2"` (`backblaze-b2`), `"tigris"`,
   * `"supabase"`, `"cloudinary"`, `"appwrite"`, `"box"` and `"memory"` for
   * their own adapters. Other adapters (`bun-s3`, `s3` on a custom endpoint,
   * unverified S3-compatible services) declare none; set it when you know the
   * provider sends one of {@link EVENT_FORMATS}.
   */
  format?: EventFormat;
  /**
   * Only accept provider events for this bucket (container, for Azure).
   * Defaults to the adapter's own bucket when it exposes one
   * (`adapter.bucket`), so a queue, topic or webhook that also carries other
   * buckets' events (an EventBridge rule, an Azure system topic, a Supabase or
   * Appwrite project webhook) can't feed them in under the same keys. Events
   * whose delivery doesn't name a bucket pass. `false` accepts every bucket.
   */
  bucket?: string | false;
  /**
   * Also raise events for successful `upload` / `delete` / `copy` / `move`
   * calls made through this instance (`source: "sdk"`). Off by default: on a
   * provider with notifications each write then arrives twice. Useful where a
   * provider has none. Delivered after the call settles and not awaited; a
   * failing handler goes to `onError`. `events()` must then come before any
   * plugin that maps storage events (`versioning`, `softDelete`, `dedup`,
   * `encryption`, `compression`, `tiering`) in `plugins`, or the instance
   * refuses to build: behind one, it would see that plugin's internal keys
   * and stored sizes.
   */
  sdk?: boolean;
  /** Skip events whose `id` this store has seen. See {@link EventDedupeStore}. */
  dedupe?: EventDedupeStore;
  /** How long a handled id is remembered, ms. Default 24 hours. */
  dedupeTtl?: number;
  /**
   * Called for every handler that throws, whatever the source. `dispatch()`,
   * `emit()` and the webhook still reject (so the provider redelivers); events
   * nothing awaits (the memory adapter, the `sdk` source, gateway uploads) are
   * reported only here. Defaults to `console.error`.
   */
  onError?: (cause: unknown, event: FileEvent) => void;
}

/**
 * `files.events`. `parse()` / `dispatch()` / `webhook()` read the provider's
 * deliveries; handlers registered with `on()` receive provider events, gateway
 * upload completions, and (with `sdk: true`) this instance's own writes.
 */
export interface FilesEvents {
  /** The notification format this instance reads, or `undefined` when its adapter has none. */
  readonly format: EventFormat | undefined;
  /**
   * Handle events of `type` whose key matches `pattern` (a glob, `**` when
   * omitted; matched against the caller-facing key). Handlers run in
   * registration order. Returns a function that removes the handler. When the
   * instance reads a notification format, throws if a plugin refuses provider
   * events (as `webhook()` does), rather than dropping every one later.
   */
  on: {
    (type: EventTypeFilter, handler: EventHandler): () => void;
    (type: EventTypeFilter, pattern: string, handler: EventHandler): () => void;
  };
  /**
   * Normalize deliveries into events without running handlers: a webhook
   * `Request`, a message body (an SQS record body, a Queue message body, a
   * Pub/Sub message), a whole consumer batch (a Lambda event), a JSON string,
   * or an array of any of those. Events outside the instance `prefix`, or for
   * another `bucket`, are dropped. Doesn't authenticate a `Request`; use
   * `webhook()` for that.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
  parse: (input: unknown) => Promise<FileEvent[]>;
  /**
   * `parse()`, then run the matching handlers (sequentially, in order). Rejects
   * when a handler throws, after every event has been tried, so a queue
   * consumer can leave the message for redelivery. Resolves with the events
   * handled.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
  dispatch: (input: unknown) => Promise<FileEvent[]>;
  /** Run the matching handlers for events you already have (no parsing, no prefix mapping). */
  emit: (events: FileEvent | readonly FileEvent[]) => Promise<void>;
  /**
   * A webhook endpoint for providers that push over HTTP, with the same
   * `{ handle }` shape as the gateway, so every gateway binding mounts it
   * (`createRouteHandler(files.events.webhook({ verify }))`). Answers the
   * provider handshakes, authenticates, then dispatches: `401` on a bad
   * credential, `400` on a malformed delivery, `502` when fetching a signing
   * certificate or key fails and `500` when a handler throws (the provider
   * redelivers either), `200` otherwise. A handler's error message never
   * reaches the response; it goes to `onError`.
   */
  webhook: (opts: EventsWebhookOptions) => WebhookHandler;
  /**
   * Resolves once every event delivered without an awaiting caller (memory
   * adapter changes, `sdk` writes) has been handled, including any those
   * handlers caused. For tests.
   */
  settled: () => Promise<void>;
}

/** What {@link events} adds to a `Files` instance (a `type`, for `createFiles`). */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a `type`: an interface has no implicit index signature and wouldn't satisfy FilesPlugin's extension constraint
export type EventsExtension = { events: FilesEvents };

const DAY = 24 * 60 * 60 * 1000;

interface Registration {
  type: EventTypeFilter;
  matches: (key: string) => boolean;
  handler: EventHandler;
}

/** The errors `emit()` rejects with because handlers threw (each one already reported to `onError`). */
const handlerFailures = new WeakSet<object>();

const decode = (text: string): JsonValue => {
  try {
    // SAFETY: `JSON.parse` returns exactly the `JsonValue` value space.
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new FilesError(
      "Invalid",
      "files-sdk/events: delivery is not JSON",
      error
    );
  }
};

// A delivery body as the caller handed it, flattened: arrays are batches (a
// Queue batch's bodies, an Event Grid array), strings are JSON to decode.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
const flatten = (input: unknown, headers?: Headers): Delivery[] => {
  if (Array.isArray(input)) {
    return input.flatMap((item) => flatten(item, headers));
  }
  if (isString(input)) {
    return flatten(decode(input), headers);
  }
  if (isJsonObject(input)) {
    return [{ body: input, ...(headers && { headers }) }];
  }
  throw new FilesError(
    "Invalid",
    "files-sdk/events: expected a Request, a JSON string, an object, or an array of them"
  );
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
const toDeliveries = async (input: unknown): Promise<Delivery[]> => {
  if (input instanceof Request) {
    const text = await input.text();
    return flatten(decode(text), input.headers);
  }
  return flatten(input);
};

const handlerFailure = (failures: readonly unknown[]): FilesError => {
  const [first] = failures;
  const message = first instanceof Error ? first.message : String(first);
  const error = new FilesError(
    "Provider",
    failures.length === 1
      ? `files-sdk/events: a handler failed: ${message}`
      : `files-sdk/events: ${failures.length} handlers failed; first: ${message}`,
    failures.length === 1
      ? first
      : new AggregateError(failures, "files-sdk/events: handlers failed")
  );
  handlerFailures.add(error);
  return error;
};

const defaultOnError = (cause: unknown, event: FileEvent): void => {
  // oxlint-disable-next-line no-console -- the default for a handler failure nothing else would see; override with `onError`.
  console.error(
    `files-sdk/events: ${event.type} handler failed for ${event.key}`,
    cause
  );
};

// The events a successful write through the instance stands for.
const sdkEvents = (
  op: FilesOperation,
  result: OperationResult<FilesOperation>,
  provider: string
): FileEvent[] => {
  const base = { provider, source: "sdk" as const, time: Date.now() };
  const event = (
    type: FileEventType,
    key: string,
    extra: Partial<FileEvent> = {}
  ): FileEvent => ({
    ...base,
    id: `sdk:${crypto.randomUUID()}`,
    key,
    raw: { operation: op.kind },
    type,
    ...extra,
  });
  switch (op.kind) {
    case "upload": {
      // SAFETY: the engine pairs each op with its own verb's result — an
      // upload's `next` resolves to its `UploadResult`.
      const uploaded = result as UploadResult;
      return [
        event("created", op.key, {
          contentType: uploaded.contentType,
          size: uploaded.size,
          time: uploaded.lastModified ?? base.time,
          ...(uploaded.etag !== undefined && { etag: uploaded.etag }),
        }),
      ];
    }
    case "delete": {
      return [event("deleted", op.key)];
    }
    case "copy": {
      return [event("created", op.to)];
    }
    case "move": {
      return [event("deleted", op.from), event("created", op.to)];
    }
    default: {
      return [];
    }
  }
};

/** The bucket the adapter is bound to, when it exposes one (`adapter.bucket`). */
const bucketOf = (adapter: Files["adapter"]): string | undefined =>
  "bucket" in adapter && isString(adapter.bucket) && adapter.bucket !== ""
    ? adapter.bucket
    : undefined;

/**
 * A provider event to fold through the instance at startup, so a plugin that
 * refuses provider events (`tiering({ fallback: true })`) fails then, not on
 * the first delivery.
 */
const probeOf = (files: Files): FileEvent => ({
  id: "files-sdk/events:probe",
  key: files.prefix ? `${files.prefix}/probe` : "probe",
  provider: files.adapter.name,
  raw: null,
  source: "provider",
  time: 0,
  type: "created",
});

/** The memory adapter's change feed, when `adapter` is one. */
const memoryFeed = (
  adapter: Files["adapter"]
):
  | { subscribe: (listener: (change: MemoryNotification) => void) => void }
  | undefined => {
  if (adapter.name !== "memory" || !("subscribe" in adapter)) {
    return undefined;
  }
  const { subscribe } = adapter;
  // SAFETY: the memory adapter (name "memory") is the only adapter with a
  // `subscribe` member, and its signature is `MemoryAdapter["subscribe"]`.
  return isFunction(subscribe)
    ? {
        subscribe: subscribe as (
          listener: (change: MemoryNotification) => void
        ) => void,
      }
    : undefined;
};

/**
 * React to files being created or deleted, however it happened: provider
 * bucket notifications, gateway uploads, and (opt-in) this instance's own
 * writes, normalized into one {@link FileEvent} and routed to handlers.
 *
 * ```ts
 * const files = createFiles({ adapter: s3({ bucket }), plugins: [events()] });
 * files.events.on("created", "avatars/**", async (e) => { … });
 *
 * // Lambda / SQS consumer
 * export const handler = (event) => files.events.dispatch(event);
 * ```
 *
 * Install one `events()` per instance; put it first in `plugins` so the `sdk`
 * source sees the caller's keys.
 */
export const events = (
  options: EventsOptions = {}
): FilesPlugin<EventsExtension> => {
  if (options.format !== undefined && !isEventFormat(options.format)) {
    throw new FilesError(
      "Invalid",
      `events(): unknown format "${String(options.format)}" (expected one of ${EVENT_FORMATS.join(", ")})`
    );
  }
  const registrations: Registration[] = [];
  const inflight = new Set<Promise<void>>();
  const onError = options.onError ?? defaultOnError;
  const ttl = options.dedupeTtl ?? DAY;
  const run = async (event: FileEvent, failures: unknown[]): Promise<void> => {
    if (await options.dedupe?.has(event.id)) {
      return;
    }
    let ok = true;
    // A snapshot, so a handler that registers or removes one mid-delivery
    // doesn't change who sees this event.
    const snapshot = [...registrations];
    for (const registration of snapshot) {
      if (
        (registration.type !== "*" && registration.type !== event.type) ||
        !registration.matches(event.key)
      ) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- handlers run in registration order, one at a time
        await registration.handler(event);
      } catch (error) {
        ok = false;
        failures.push(error);
        try {
          onError(error, event);
        } catch {
          // a throwing reporter can't stop the delivery
        }
      }
    }
    if (ok) {
      await options.dedupe?.add(event.id, ttl);
    }
  };

  const emit = async (input: FileEvent | readonly FileEvent[]) => {
    const list: readonly FileEvent[] = Array.isArray(input) ? input : [input];
    const failures: unknown[] = [];
    for (const event of list) {
      // oxlint-disable-next-line no-await-in-loop -- events are handled in delivery order
      await run(event, failures);
    }
    if (failures.length > 0) {
      throw handlerFailure(failures);
    }
  };

  // `emit()` on a later tick (never inside the caller's own call), for a
  // delivery nobody awaits. Never rejects: failures already went to `onError`.
  const emitQuietly = async (list: readonly FileEvent[]): Promise<void> => {
    await Promise.resolve();
    try {
      await emit(list);
    } catch {
      // Already reported to `onError`; nothing awaits this delivery.
    }
  };

  // A delivery nobody awaits: tracked for `settled()` until it's handled.
  // Callers don't await this; it never rejects.
  const background = async (list: readonly FileEvent[]): Promise<void> => {
    if (list.length === 0) {
      return;
    }
    const done = emitQuietly(list);
    inflight.add(done);
    await done;
    inflight.delete(done);
  };

  const formatOf = (files: Files): EventFormat | undefined =>
    options.format ??
    (files.capabilities.events ? files.capabilities.events.format : undefined);

  const parserOf = (files: Files): EventParser => {
    const format = formatOf(files);
    if (format) {
      return parserFor(format);
    }
    const { name } = files.adapter;
    // The adapter declares a format, but a plugin's `capabilities` hook
    // turned it off: passing `format` would only hit that plugin's refusal.
    if (files.adapter.capabilities?.events) {
      throw new FilesError(
        "Unsupported",
        `files-sdk/events: the ${name} adapter has no notification format on this instance: a plugin turned provider events off (tiering with \`fallback: true\` does, since it can't map them); react to gateway uploads or events({ sdk: true }) instead`
      );
    }
    throw new FilesError(
      "Unsupported",
      `files-sdk/events: the ${name} adapter has no notification format; pass a \`format\` (${EVENT_FORMATS.join(", ")}) if its provider sends one of them`
    );
  };

  // The bucket provider events must be for: the option, else the adapter's.
  const bucketFilter = (files: Files): string | undefined =>
    options.bucket === false
      ? undefined
      : (options.bucket ?? bucketOf(files.adapter));

  // Provider deliveries → caller-facing events: stamp the source, drop other
  // buckets, then map onto the instance (prefix, plugin `event` hooks).
  const normalize = (
    files: Files,
    parser: EventParser,
    deliveries: readonly Delivery[]
  ): FileEvent[] => {
    const only = bucketFilter(files);
    return deliveries.flatMap((delivery) =>
      parser
        .parse(delivery, { adapter: files.adapter })
        .flatMap(({ bucket, ...raw }) => {
          if (only !== undefined && bucket !== undefined && bucket !== only) {
            return [];
          }
          const folded = files[FOLD_PROVIDER_EVENT]({
            ...raw,
            provider: files.adapter.name,
            source: "provider",
          });
          return folded ? [folded] : [];
        })
    );
  };

  // Fold the startup probe: throws when a plugin refuses provider events.
  const probe = (files: Files): void => {
    files[FOLD_PROVIDER_EVENT](probeOf(files));
  };

  const settled = async (): Promise<void> => {
    while (inflight.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- handlers may start new deliveries; drain until none are left
      await Promise.allSettled(inflight);
    }
  };

  // The namespace, bound to the instance it was installed on.
  const namespaceFor = (files: Files): FilesEvents => {
    let subscribed = false;

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
    const parse = async (input: unknown): Promise<FileEvent[]> =>
      normalize(files, parserOf(files), await toDeliveries(input));

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public boundary: queue/webhook deliveries arrive untyped and are parsed here
    const dispatch = async (input: unknown): Promise<FileEvent[]> => {
      const list = await parse(input);
      await emit(list);
      return list;
    };

    // The memory adapter pushes its changes; listen once a handler exists.
    const subscribeMemory = (): void => {
      const feed =
        subscribed || formatOf(files) === undefined
          ? undefined
          : memoryFeed(files.adapter);
      if (!feed) {
        return;
      }
      subscribed = true;
      const parser = parserFor("memory");
      feed.subscribe((change) => {
        background(normalize(files, parser, [{ body: { ...change } }]));
      });
    };

    const on = (
      type: EventTypeFilter,
      patternOrHandler: string | EventHandler,
      maybeHandler?: EventHandler
    ): (() => void) => {
      const pattern = isString(patternOrHandler) ? patternOrHandler : "**";
      const handler = isString(patternOrHandler)
        ? maybeHandler
        : patternOrHandler;
      if (!isFunction(handler)) {
        throw new FilesError(
          "Invalid",
          "files.events.on(): expected a handler function"
        );
      }
      // Where provider events can arrive, a plugin that refuses them fails
      // here, not silently on every delivery. (An instance with no format —
      // `tiering({ fallback: true })` declares none — still gets gateway and
      // `sdk` events.)
      if (formatOf(files) !== undefined) {
        probe(files);
      }
      const registration: Registration = {
        handler,
        matches: globMatcher(pattern, false),
        type,
      };
      registrations.push(registration);
      subscribeMemory();
      return () => {
        const index = registrations.indexOf(registration);
        if (index !== -1) {
          registrations.splice(index, 1);
        }
      };
    };

    const webhook = (opts: EventsWebhookOptions): WebhookHandler => {
      const parser = parserOf(files);
      probe(files);
      return createWebhook(opts, {
        decode: (body, headers) => flatten(decode(body), headers),
        emit,
        isHandlerFailure: (error) =>
          error instanceof Error && handlerFailures.has(error),
        normalize: (format, deliveries) => normalize(files, format, deliveries),
        parser,
      });
    };

    return {
      dispatch,
      emit,
      format: formatOf(files),
      // SAFETY: `on`'s implementation accepts both overload shapes and checks
      // the handler at runtime; the overload set is what callers see.
      on: on as FilesEvents["on"],
      parse,
      settled,
      webhook,
    };
  };

  let owner: { files: Files; namespace: FilesEvents } | undefined;

  // While set, this plugin's `event` hook hands the event it receives to the
  // tap (for the plugin-order check below); otherwise the hook is a no-op.
  let tap: ((event: FileEvent) => FileEvent) | undefined;

  /**
   * Whether a plugin listed before this one (outside it, so it sees ops after
   * that plugin rewrote them) maps storage events — the sign it changes keys
   * or sizes on the way in. Folds a probe and watches it leave this plugin's
   * hook: an outer hook that reads it, replaces it, drops it, or throws is
   * one. (An inner hook that drops or refuses the probe first hides the
   * outside; then nothing is found.)
   */
  const outerMapsEvents = (files: Files): boolean => {
    let handed: FileEvent | undefined;
    let touched = false;
    const touch = (): void => {
      touched = true;
    };
    tap = (event) => {
      handed = new Proxy(
        { ...event },
        {
          get: (target, property, receiver) => {
            touch();
            // oxlint-disable-next-line anti-slop/no-reflect-get -- a transparent Proxy trap forwards the read unchanged; it parses no input
            return Reflect.get(target, property, receiver);
          },
          getOwnPropertyDescriptor: (target, property) => {
            touch();
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
          has: (target, property) => {
            touch();
            return Reflect.has(target, property);
          },
          ownKeys: (target) => {
            touch();
            return Reflect.ownKeys(target);
          },
        }
      );
      return handed;
    };
    try {
      const out = files[FOLD_PROVIDER_EVENT](probeOf(files));
      return handed !== undefined && (touched || out !== handed);
    } catch {
      return handed !== undefined;
    } finally {
      tap = undefined;
    }
  };

  // SAFETY: the engine folds `wrap` over the erased `FilesOperation` union and
  // re-narrows the result per call; this wrap resolves with exactly the value
  // `next` produced for the op it was handed.
  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<OperationResult<FilesOperation>> => {
    const result = await next(op);
    if (owner) {
      background(sdkEvents(op, result, owner.files.adapter.name));
    }
    return result;
  }) as FilesPlugin["wrap"];

  return {
    // A pass-through, but for the plugin-order check's tap.
    event: (event) => (tap ? tap(event) : event),
    extend: (files) => {
      // `files.readonly()` re-runs `extend` on a clone of the same instance;
      // it shares this plugin's handlers. A second, unrelated instance would
      // silently fold its events against the first, so refuse it.
      if (owner && owner.files.adapter !== files.adapter) {
        throw new FilesError(
          "Invalid",
          "events(): this plugin is already installed on another Files instance; create one events() per instance"
        );
      }
      if (options.sdk && outerMapsEvents(files)) {
        throw new FilesError(
          "Invalid",
          "events({ sdk: true }): a plugin listed before events() maps storage keys or sizes (versioning, softDelete, dedup, encryption, compression, tiering…), so the sdk source would report its internal keys and stored sizes; list events() first in `plugins`"
        );
      }
      owner ??= { files, namespace: namespaceFor(files) };
      return { events: owner.namespace };
    },
    name: "events",
    ...(options.sdk && { wrap }),
  };
};
