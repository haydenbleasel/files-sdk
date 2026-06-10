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

/** Which of the two stores an object lives in (or should be written to). */
export type Tier = "hot" | "cold";

/**
 * The inputs {@link TieringOptions.route} decides a {@link Tier} from. It's
 * called once per logical operation, on the **caller-facing** key:
 *
 * - on `upload`, with `size` set to the body's declared byte length when it's
 *   known up front (string / `Blob` / `ArrayBuffer` / typed array);
 * - on every other decision (reads, `delete`, the destination of `copy` /
 *   `move`, `signedUploadUrl`, and locating an object), with `size` **omitted**
 *   — those inputs have no body to measure.
 *
 * Write a function whose result is stable for a given key (e.g. routing by key
 * prefix) and reads land on the right tier first try. Route by `size` — which
 * reads can't recompute — and enable {@link TieringOptions.fallback} so a read
 * that misses the guessed tier transparently checks the other.
 */
export interface TierContext {
  /** The caller-facing object key the decision is for. */
  key: string;
  /**
   * Declared body length in bytes, present only on `upload` and only when the
   * body's length is known without consuming it. `undefined` for streaming
   * uploads and on every read / locate decision.
   */
  size?: number;
}

/** Decide which {@link Tier} an operation routes to. See {@link TierContext}. */
export type TierRouter = (context: TierContext) => Tier;

export interface TieringOptions {
  /**
   * The cold tier — a second {@link Adapter} the plugin drives directly (wrapped
   * in its own internal {@link Files}, so cold-tier calls get the same retry,
   * capability gating, and `StoredFile` normalization the hot tier does). The
   * hot tier is the instance's own adapter, reached through the rest of the
   * onion. Configure the cold adapter with its **own** bucket / container; it
   * receives caller-facing keys (the instance `prefix` is **not** applied to
   * it).
   */
  cold: Adapter;
  /**
   * Decide which {@link Tier} each operation routes to. Required — there's no
   * sensible default for "hot vs cold". See {@link TierContext} for what it's
   * handed and when.
   */
  route: TierRouter;
  /**
   * When `true`, treat an object's tier as **discoverable** rather than fixed:
   * a read that misses the routed tier retries the other; `delete` removes the
   * key from both tiers; and an `upload` evicts the key from the other tier so
   * exactly one copy ever exists. Turn this on for `size`-based routing or when
   * you move objects between tiers with {@link TieringApi.tier} (e.g. age-based
   * transitions) — anything where the tier isn't a pure function of the key.
   *
   * Defaults to `false`: routing is deterministic, every op touches exactly the
   * one tier {@link TieringOptions.route} names, and there's no extra round-trip
   * — the right choice for prefix / key-based routing.
   */
  fallback?: boolean;
}

/**
 * The methods {@link tiering} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type TieringApi = {
  /**
   * Report which {@link Tier} currently holds `key`, or `undefined` when neither
   * tier does. Checks the routed tier first, then the other (regardless of
   * {@link TieringOptions.fallback}, so it always gives a definitive answer).
   */
  tierOf(key: string): Promise<Tier | undefined>;
  /**
   * Move `key` to `target`, streaming the object across adapters and removing
   * the source copy. A no-op when it's already there. Throws `NotFound` when
   * neither tier holds the key. This is the lever for age-based transitions:
   * list, check `lastModified`, and `tier(key, "cold")` what's gone cold. Pair
   * it with `fallback: true` so reads still find what you've moved.
   */
  tier(key: string, target: Tier): Promise<void>;
};

/**
 * The slice of the {@link Files} surface the tiering engine drives on each tier.
 * A `Files` instance (the cold tier) supplies these directly; the hot tier
 * supplies them by re-routing through the plugin `next`, so both tiers run their
 * verbs the same way.
 */
interface TierRunner {
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

/** Compose a {@link TierRunner} from a {@link Files} instance (the cold tier). */
const runnerFor = (files: Files): TierRunner => ({
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
 * Compose a {@link TierRunner} for the hot tier from the plugin `next`. Each
 * verb rebuilds its {@link FilesOperation} and continues inward, so the hot tier
 * keeps the rest of the onion, the instance `prefix`, and the `#run` retry loop.
 */
const runnerViaNext = (next: PluginNext): TierRunner => ({
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

/** Byte length of a body when it's knowable without consuming a stream. */
const declaredSize = (body: Body): number | undefined => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  // A ReadableStream has no declared length — route it by key alone.
  return undefined;
};

const isNotFound = (error: unknown): boolean =>
  error instanceof FilesError && error.code === "NotFound";

/** Stable key ordering for the merged listing, matching provider sort order. */
const byKey = (a: StoredFile, b: StoredFile): number => {
  if (a.key < b.key) {
    return -1;
  }
  return a.key > b.key ? 1 : 0;
};

/** The tier an operation didn't route to. */
const otherTier = (tier: Tier): Tier => (tier === "hot" ? "cold" : "hot");

/** Stream an object from one tier to another, preserving type and metadata. */
const transferAcross = async (
  src: TierRunner,
  dst: TierRunner,
  from: string,
  to: string,
  opts?: OperationOptions
): Promise<void> => {
  const file = await src.download(from, opts);
  const uploadOpts: UploadOptions = {
    contentType: file.type,
    ...(file.metadata &&
      Object.keys(file.metadata).length > 0 && { metadata: file.metadata }),
  };
  await dst.upload(to, file.stream(), uploadOpts);
};

/**
 * One tier's slice of the composite cursor. `cursor` is what to query the tier
 * with next — a provider cursor, or `null` for "from the top" (used when a
 * page wasn't fully emitted and must be re-fetched). A tier with no slot in
 * the composite cursor is fully drained *and* fully emitted.
 */
interface TierCursor {
  cursor?: string | null;
  /** Drop entries (keys and prefixes) `<=` this from the re-fetched page. */
  skip?: string;
}

/** A merged listing's composite cursor: one slot per tier still in play. */
interface ListCursor {
  h?: TierCursor;
  c?: TierCursor;
}

const decodeCursor = (raw: string): ListCursor | undefined => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ListCursor)
      : undefined;
  } catch {
    return undefined;
  }
};

/** One tier's fetched (and skip-filtered) page, plus how it was queried. */
interface TierPage {
  items: StoredFile[];
  prefixes: string[];
  /** Provider continuation for the page, when the tier has more. */
  next?: string;
  /** The cursor this page was queried with (`null` = from the top). */
  queriedWith: string | null;
}

/**
 * Fetch one tier's page of a merged listing. A fresh call (no composite
 * cursor) queries from the top; otherwise the tier is queried only while its
 * slot is present (`undefined` once drained-and-emitted), re-applying the
 * slot's `skip` so entries already emitted from a re-fetched page stay out.
 */
const fetchTierPage = async (
  runner: TierRunner,
  base: ListOptions,
  slot: TierCursor | undefined,
  fresh: boolean
): Promise<TierPage | undefined> => {
  if (!fresh && slot === undefined) {
    return undefined;
  }
  const cursor = fresh ? undefined : (slot?.cursor ?? undefined);
  const page = await runner.list(
    cursor === undefined ? base : { ...base, cursor }
  );
  const skip = fresh ? undefined : slot?.skip;
  const items =
    skip === undefined ? page.items : page.items.filter((f) => f.key > skip);
  const prefixes = (page.prefixes ?? []).filter(
    (p) => skip === undefined || p > skip
  );
  return {
    items,
    prefixes,
    queriedWith: cursor ?? null,
    ...(page.cursor !== undefined && { next: page.cursor }),
  };
};

/**
 * The highest key/prefix position a tier's page covers, or `undefined` for an
 * empty page (an empty page with a continuation covers nothing knowable yet).
 */
const pageMax = (page: TierPage): string | undefined => {
  const lastItem = page.items.at(-1)?.key;
  const lastPrefix = page.prefixes.at(-1);
  if (lastItem === undefined) {
    return lastPrefix;
  }
  if (lastPrefix === undefined) {
    return lastItem;
  }
  return lastItem > lastPrefix ? lastItem : lastPrefix;
};

/**
 * The merged page's emission bound: entries `<= bound` are emitted now,
 * entries above it are held back and re-fetched next round. Bounded by the
 * lowest page-max among tiers that still have more pages, so emission is
 * globally key-ordered across rounds — that ordering is what makes a
 * cross-page duplicate (the same key surfacing from both tiers in different
 * rounds) impossible. `{ emitAll: true }` when every in-play tier is on its
 * final page; `{ emitNone: true }` when a tier returned an empty page with a
 * continuation (its coverage is unknowable, so nothing can safely be emitted).
 */
const emissionBound = (
  pages: (TierPage | undefined)[]
): { bound?: string; emitAll?: boolean; emitNone?: boolean } => {
  let bound: string | undefined;
  for (const page of pages) {
    if (page?.next === undefined) {
      continue;
    }
    const max = pageMax(page);
    if (max === undefined) {
      return { emitNone: true };
    }
    if (bound === undefined || max < bound) {
      bound = max;
    }
  }
  return bound === undefined ? { emitAll: true } : { bound };
};

/** Split a page's entries into the emitted slice and the held-back slice. */
const splitAtBound = (
  page: TierPage,
  bound: { bound?: string; emitAll?: boolean; emitNone?: boolean }
): { emit: TierPage; held: boolean } => {
  if (bound.emitAll) {
    return { emit: page, held: false };
  }
  if (bound.emitNone) {
    // Holding only applies to a page that actually has entries — the tier
    // that produced the empty page must advance its cursor, or the merged
    // listing would re-fetch the same empty page forever.
    return {
      emit: { ...page, items: [], prefixes: [] },
      held: page.items.length > 0 || page.prefixes.length > 0,
    };
  }
  const limit = bound.bound as string;
  const items = page.items.filter((f) => f.key <= limit);
  const prefixes = page.prefixes.filter((p) => p <= limit);
  return {
    emit: { ...page, items, prefixes },
    held:
      items.length < page.items.length ||
      prefixes.length < page.prefixes.length,
  };
};

/** A tier's next composite-cursor slot, or `undefined` when it's finished. */
const nextSlot = (
  page: TierPage | undefined,
  held: boolean,
  bound: { bound?: string; emitNone?: boolean },
  previousSkip: string | undefined
): TierCursor | undefined => {
  if (page === undefined) {
    return undefined;
  }
  if (held) {
    // Re-fetch the same page next round and drop what was emitted this round
    // (`emitNone` emitted nothing, so the previous skip still stands).
    const skip = bound.emitNone ? previousSkip : bound.bound;
    return { cursor: page.queriedWith, ...(skip !== undefined && { skip }) };
  }
  return page.next === undefined ? undefined : { cursor: page.next };
};

/** One tier's emitted slice and continuation slot for a merged-list round. */
const tierOutcome = (
  page: TierPage | undefined,
  bound: { bound?: string; emitAll?: boolean; emitNone?: boolean },
  previousSkip: string | undefined
): { emit?: TierPage; slot?: TierCursor } => {
  if (page === undefined) {
    return {};
  }
  const { emit, held } = splitAtBound(page, bound);
  const slot = nextSlot(page, held, bound, previousSkip);
  return { emit, ...(slot !== undefined && { slot }) };
};

/** Interleave both tiers' emitted items, deduped (hot wins), sorted by key. */
const mergeItems = (pages: (TierPage | undefined)[]): StoredFile[] => {
  const seen = new Set<string>();
  const items: StoredFile[] = [];
  for (const page of pages) {
    for (const file of page?.items ?? []) {
      if (!seen.has(file.key)) {
        seen.add(file.key);
        items.push(file);
      }
    }
  }
  return items.toSorted(byKey);
};

/** Union both tiers' emitted delimiter prefixes, sorted. */
const mergePrefixes = (pages: (TierPage | undefined)[]): string[] => {
  const set = new Set<string>();
  for (const page of pages) {
    for (const prefix of page?.prefixes ?? []) {
      set.add(prefix);
    }
  }
  return [...set].toSorted();
};

/**
 * Route by size / prefix / age to a hot and a cold {@link Adapter}, so an
 * `upload` lands in the right store and every read transparently finds it again.
 * The **hot** tier is the instance's own adapter (reached through the rest of
 * the onion); the **cold** tier is a second adapter passed in
 * {@link TieringOptions.cold}. {@link TieringOptions.route} decides per
 * operation.
 *
 * What each verb does:
 * - **`upload`** routes by `route({ key, size })` (`size` is the body's declared
 *   length when known). With `fallback`, it then evicts the key from the other
 *   tier so a re-upload that flips tiers leaves exactly one copy.
 * - **`download` / `head` / `url` / `exists`** consult the routed tier; with
 *   `fallback` they fall through to the other tier on a miss, so `size`-routed
 *   and hand-moved objects are still found.
 * - **`delete`** removes the routed tier's copy; with `fallback`, both tiers'.
 * - **`copy` / `move`** locate the source, route the destination by key, and use
 *   a native same-tier op or stream the bytes across when the tiers differ.
 * - **`list`** merges a page from each tier (keys sorted within the page),
 *   paginating the two independently via a composite cursor.
 * - **`signedUploadUrl`** signs against the tier `route({ key })` picks; the
 *   resulting direct upload bypasses the plugin, so it can't be size-routed or
 *   deduplicated.
 *
 * It's **body-transparent** — it never buffers or transforms bytes (a cross-tier
 * copy streams) — and adds two methods via `extend`: {@link TieringApi.tierOf}
 * and {@link TieringApi.tier}. Use {@link createFiles} to surface them on the
 * type.
 *
 * Placement and prefixes:
 * - Place it **last** (innermost) so body-transforming plugins
 *   (`encryption()`, `compression()`) wrap it and apply to **both** tiers.
 * - Address objects by caller-facing keys: the cold adapter does **not** receive
 *   the instance `prefix` (configure its own bucket / container), while the hot
 *   tier — including {@link TieringApi.tierOf} / {@link TieringApi.tier} — does.
 *
 * @param options `{ cold, route, fallback? }` — see {@link TieringOptions}.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { tiering } from "files-sdk/tiering";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "hot" }), // hot tier
 *   plugins: [
 *     tiering({
 *       cold: s3({ bucket: "cold" }),
 *       // archives go cold; everything else stays hot
 *       route: ({ key }) => (key.startsWith("archive/") ? "cold" : "hot"),
 *     }),
 *   ],
 * });
 *
 * await files.upload("photo.jpg", body); // → hot
 * await files.upload("archive/2019.zip", zip); // → cold
 * await files.download("archive/2019.zip"); // transparently read from cold
 * await files.tier("photo.jpg", "cold"); // age it down (needs fallback: true)
 * ```
 */
export const tiering = (options: TieringOptions): FilesPlugin<TieringApi> => {
  if (!options?.cold) {
    throw new FilesError("Provider", "tiering: a cold adapter is required");
  }
  if (typeof options.route !== "function") {
    throw new FilesError("Provider", "tiering: a route function is required");
  }
  const { route } = options;
  const fallback = options.fallback ?? false;
  const cold = runnerFor(new Files({ adapter: options.cold }));

  const pick = (hot: TierRunner, tier: Tier): TierRunner =>
    tier === "hot" ? hot : cold;

  /** Find which tier holds `key`, checking the routed one first. */
  const locate = async (
    hot: TierRunner,
    key: string
  ): Promise<Tier | undefined> => {
    const guess = route({ key });
    if (await pick(hot, guess).exists(key)) {
      return guess;
    }
    return (await pick(hot, otherTier(guess)).exists(key))
      ? otherTier(guess)
      : undefined;
  };

  /** Run a fetch on the routed tier, falling through to the other on a miss. */
  const readThrough = async <T>(
    hot: TierRunner,
    key: string,
    run: (runner: TierRunner) => Promise<T>
  ): Promise<T> => {
    const guess = route({ key });
    if (!fallback) {
      return run(pick(hot, guess));
    }
    try {
      return await run(pick(hot, guess));
    } catch (error) {
      if (isNotFound(error)) {
        return run(pick(hot, otherTier(guess)));
      }
      throw error;
    }
  };

  const existsAcross = async (
    hot: TierRunner,
    key: string,
    opts?: OperationOptions
  ): Promise<boolean> => {
    const guess = route({ key });
    if (await pick(hot, guess).exists(key, opts)) {
      return true;
    }
    if (!fallback) {
      return false;
    }
    return pick(hot, otherTier(guess)).exists(key, opts);
  };

  const uploadRouted = async (
    hot: TierRunner,
    key: string,
    body: Body,
    opts?: UploadOptions
  ): Promise<UploadResult> => {
    const size = declaredSize(body);
    const tier = route({ key, ...(size !== undefined && { size }) });
    const result = await pick(hot, tier).upload(key, body, opts);
    if (fallback) {
      // Keep a single copy: a re-upload that flips tiers would otherwise leave a
      // stale shadow that a fallback read could surface first.
      await pick(hot, otherTier(tier)).delete(key);
    }
    return result;
  };

  const deleteRouted = async (
    hot: TierRunner,
    key: string,
    opts?: OperationOptions
  ): Promise<void> => {
    if (fallback) {
      // The key could be in either tier; deleting a missing one is a no-op.
      await pick(hot, "hot").delete(key, opts);
      await pick(hot, "cold").delete(key, opts);
      return;
    }
    await pick(hot, route({ key })).delete(key, opts);
  };

  const copyOrMove = async (
    hot: TierRunner,
    from: string,
    to: string,
    isMove: boolean,
    opts?: OperationOptions
  ): Promise<void> => {
    const srcTier = fallback
      ? ((await locate(hot, from)) ?? route({ key: from }))
      : route({ key: from });
    const dstTier = route({ key: to });
    const src = pick(hot, srcTier);
    const dst = pick(hot, dstTier);
    if (srcTier === dstTier) {
      await (isMove ? src.move(from, to, opts) : src.copy(from, to, opts));
    } else {
      await transferAcross(src, dst, from, to, opts);
      if (isMove) {
        await src.delete(from, opts);
      }
    }
    if (fallback) {
      // Drop any stale copy of the destination key in the tier it didn't land in.
      await pick(hot, otherTier(dstTier)).delete(to);
    }
  };

  /** Merge one page from each tier into a single result with a composite cursor. */
  const listMerged = async (
    hot: TierRunner,
    opts?: ListOptions
  ): Promise<ListResult> => {
    const { cursor: rawCursor, ...base } = opts ?? {};
    const fresh = rawCursor === undefined;
    const parsed = fresh ? undefined : decodeCursor(rawCursor);
    if (!fresh && parsed === undefined) {
      throw new FilesError(
        "Provider",
        "tiering: invalid list cursor — pass back the cursor a tiering list returned"
      );
    }
    const [hotPage, coldPage] = await Promise.all([
      fetchTierPage(hot, base, parsed?.h, fresh),
      fetchTierPage(cold, base, parsed?.c, fresh),
    ]);

    const bound = emissionBound([hotPage, coldPage]);
    const hotOut = tierOutcome(hotPage, bound, parsed?.h?.skip);
    const coldOut = tierOutcome(coldPage, bound, parsed?.c?.skip);

    const items = mergeItems([hotOut.emit, coldOut.emit]);
    const prefixes = mergePrefixes([hotOut.emit, coldOut.emit]);
    const cursor =
      hotOut.slot === undefined && coldOut.slot === undefined
        ? undefined
        : JSON.stringify({
            ...(hotOut.slot !== undefined && { h: hotOut.slot }),
            ...(coldOut.slot !== undefined && { c: coldOut.slot }),
          } satisfies ListCursor);
    return {
      items,
      ...(prefixes.length > 0 && { prefixes }),
      ...(cursor !== undefined && { cursor }),
    };
  };

  const dispatch = (hot: TierRunner, op: FilesOperation): Promise<unknown> => {
    switch (op.kind) {
      case "upload": {
        return uploadRouted(hot, op.key, op.body, op.options);
      }
      case "download": {
        return readThrough(hot, op.key, (r) => r.download(op.key, op.options));
      }
      case "head": {
        return readThrough(hot, op.key, (r) => r.head(op.key, op.options));
      }
      case "url": {
        return readThrough(hot, op.key, (r) => r.url(op.key, op.options));
      }
      case "exists": {
        return existsAcross(hot, op.key, op.options);
      }
      case "delete": {
        return deleteRouted(hot, op.key, op.options);
      }
      case "copy": {
        return copyOrMove(hot, op.from, op.to, false, op.options);
      }
      case "move": {
        return copyOrMove(hot, op.from, op.to, true, op.options);
      }
      case "list": {
        return listMerged(hot, op.options);
      }
      default: {
        // signedUploadUrl: sign against the tier the key would upload to.
        return pick(hot, route({ key: op.key })).signedUploadUrl(
          op.key,
          op.options as SignUploadOptions
        );
      }
    }
  };

  const wrap = ((op: FilesOperation, next: PluginNext): Promise<unknown> =>
    dispatch(runnerViaNext(next), op)) as NonNullable<FilesPlugin["wrap"]>;

  return {
    extend: (files) => {
      // The hot tier, addressed directly for the extend methods (which have no
      // `next`). Built over the instance's own adapter so it never re-enters the
      // tiering wrap — `files.tierOf(...)` would otherwise recurse. The instance
      // `prefix` must be re-applied here: the wrap path's hot runner goes
      // through `next` (which prefixes), so without it tierOf()/tier() would
      // address different hot-tier keys than every other operation.
      const hot = runnerFor(
        new Files({
          adapter: files.adapter,
          ...(files.prefix && { prefix: files.prefix }),
        })
      );
      return {
        tier: async (key, target) => {
          const current = await locate(hot, key);
          if (current === undefined) {
            throw new FilesError(
              "NotFound",
              `tiering: nothing stored for "${key}"`
            );
          }
          if (current === target) {
            return;
          }
          await transferAcross(pick(hot, current), pick(hot, target), key, key);
          await pick(hot, current).delete(key);
        },
        tierOf: (key) => locate(hot, key),
      };
    },
    name: "tiering",
    wrap,
  };
};
