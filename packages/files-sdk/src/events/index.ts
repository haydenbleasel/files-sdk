// `files-sdk/events` — one place to react when a file is created or deleted,
// however it got there. Normalizes each provider's bucket notifications (S3
// and MinIO, R2, GCS, Azure, the memory adapter) into one `FileEvent`, routes
// them to handlers by type and key glob, and serves them as a webhook endpoint
// any gateway binding can mount. Gateway upload completions and (opt-in)
// writes made through the instance feed the same handlers.
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
   * Defaults from the adapter: `s3`, `s3-fetch`, `bun-s3` and `minio` read
   * `"s3"`, `r2` reads `"r2"`, `gcs` and `firebase-storage` read `"gcs"`,
   * `azure` reads `"azure"`, `memory` reads `"memory"`. Set it for a provider
   * that sends one of these formats under another adapter (an S3-compatible
   * service whose notifications are S3-shaped).
   */
  format?: EventFormat;
  /**
   * Only accept provider events for this bucket (container, for Azure), so
   * one webhook endpoint can be shared by several buckets. Events for other
   * buckets are dropped; events whose delivery doesn't name a bucket pass.
   */
  bucket?: string;
  /**
   * Also raise events for successful `upload` / `delete` / `copy` / `move`
   * calls made through this instance (`source: "sdk"`). Off by default: on a
   * provider with notifications each write then arrives twice. Useful where a
   * provider has none. Delivered after the call settles and not awaited; a
   * failing handler goes to `onError`.
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
   * registration order. Returns a function that removes the handler.
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
   * credential, `400` on a malformed delivery, `500` when a handler throws (the
   * provider redelivers), `200` otherwise.
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
  return new FilesError(
    "Provider",
    failures.length === 1
      ? `files-sdk/events: a handler failed: ${message}`
      : `files-sdk/events: ${failures.length} handlers failed; first: ${message}`,
    failures.length === 1
      ? first
      : new AggregateError(failures, "files-sdk/events: handlers failed")
  );
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
    if (!format) {
      throw new FilesError(
        "Unsupported",
        `files-sdk/events: the ${files.adapter.name} adapter has no notification format; pass events({ format }) if its provider sends S3, R2, GCS or Azure notifications`
      );
    }
    return parserFor(format);
  };

  // Provider deliveries → caller-facing events: stamp the source, drop other
  // buckets, then map onto the instance (prefix, plugin `event` hooks).
  const normalize = (
    files: Files,
    parser: EventParser,
    deliveries: readonly Delivery[]
  ): FileEvent[] =>
    deliveries.flatMap((delivery) =>
      parser
        .parse(delivery, { adapter: files.adapter })
        .flatMap(({ bucket, ...raw }) => {
          if (
            options.bucket !== undefined &&
            bucket !== undefined &&
            bucket !== options.bucket
          ) {
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
      const feed = subscribed ? undefined : memoryFeed(files.adapter);
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
      // Fold a probe event now, so a plugin that refuses provider events
      // (`tiering({ fallback: true })`) fails at startup, not on the first
      // delivery.
      files[FOLD_PROVIDER_EVENT]({
        id: "probe",
        key: files.prefix ? `${files.prefix}/probe` : "probe",
        provider: files.adapter.name,
        raw: null,
        source: "provider",
        time: 0,
        type: "created",
      });
      return createWebhook(opts, {
        decode: (body, headers) => flatten(decode(body), headers),
        emit,
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
      owner ??= { files, namespace: namespaceFor(files) };
      return { events: owner.namespace };
    },
    name: "events",
    ...(options.sdk && { wrap }),
  };
};
