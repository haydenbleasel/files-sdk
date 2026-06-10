import type {
  FilesOperation,
  FilesPlugin,
  PluginNext,
  StoredFile,
  UploadResult,
} from "../index.js";

/** Bucket every operation lands in when no {@link UsageOptions.group} is set. */
const DEFAULT_GROUP = "all";

/** Every public verb, so {@link UsageStats.operationsByKind} has a stable shape. */
const KINDS = [
  "upload",
  "download",
  "head",
  "exists",
  "delete",
  "copy",
  "move",
  "list",
  "url",
  "signedUploadUrl",
] as const;

/**
 * A point-in-time snapshot of metered usage, returned by {@link UsageApi.usage}
 * and {@link UsageApi.usageByGroup}. Each call returns a fresh copy — mutating
 * it never touches the plugin's running totals.
 */
export interface UsageStats {
  /** Successful operations counted (each item of a bulk call counts once). */
  operations: number;
  /** The same count, broken down per verb; every verb is always present. */
  operationsByKind: Record<(typeof KINDS)[number], number>;
  /** Bytes uploaded, summed from each upload's reported result size. */
  bytesUp: number;
  /** Bytes read back out of `download` / `head` bodies, metered as they flow. */
  bytesDown: number;
}

export interface UsageOptions {
  /**
   * Bucket usage by a label derived from each operation — e.g. a tenant id or a
   * key prefix — so {@link UsageApi.usageByGroup} breaks the totals down. It
   * receives the full {@link FilesOperation}, so branch on `op.kind` to read
   * `op.key` (most verbs), `op.from` / `op.to` (`copy` / `move`), or nothing
   * (`list`). Return the same string to attribute ops to the same bucket. Omit
   * to keep a single global total.
   */
  group?: (op: FilesOperation) => string;
}

/**
 * The methods {@link usage} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type UsageApi = {
  /** Snapshot the totals, aggregated across every group. */
  usage(): UsageStats;
  /** Snapshot the totals per group, keyed by the {@link UsageOptions.group} label. */
  usageByGroup(): Record<string, UsageStats>;
  /** Zero every counter, starting a fresh accounting window. */
  resetUsage(): void;
};

const emptyByKind = (): Record<(typeof KINDS)[number], number> => {
  const out = {} as Record<(typeof KINDS)[number], number>;
  for (const kind of KINDS) {
    out[kind] = 0;
  }
  return out;
};

const emptyStats = (): UsageStats => ({
  bytesDown: 0,
  bytesUp: 0,
  operations: 0,
  operationsByKind: emptyByKind(),
});

/** A defensive copy, so a returned snapshot never aliases the running totals. */
const snapshot = (stats: UsageStats): UsageStats => ({
  bytesDown: stats.bytesDown,
  bytesUp: stats.bytesUp,
  operations: stats.operations,
  operationsByKind: { ...stats.operationsByKind },
});

/** Sum many per-group totals into one. */
const aggregate = (all: Iterable<UsageStats>): UsageStats => {
  const total = emptyStats();
  for (const stats of all) {
    total.operations += stats.operations;
    total.bytesUp += stats.bytesUp;
    total.bytesDown += stats.bytesDown;
    for (const kind of KINDS) {
      total.operationsByKind[kind] += stats.operationsByKind[kind];
    }
  }
  return total;
};

/**
 * Wrap a {@link StoredFile} so the bytes actually read out of its body are
 * counted — lazily, as they flow. `stream()` is metered chunk-by-chunk (an
 * aborted read only counts what was consumed); the buffering accessors count the
 * body's length the first time one resolves. An unread body costs nothing. The
 * wrapper delegates to the original file, so its read semantics (read-once
 * stream, cached buffering) are preserved exactly.
 */
const meterRead = (
  file: StoredFile,
  add: (bytes: number) => void
): StoredFile => {
  // At most one full read is metered, claimed by the first channel that
  // actually moves bytes. A stream-kind source is read-once, but a
  // buffer-backed file (the memory adapter, or anything a transforming
  // plugin buffered) has a *repeatable* `stream()` that coexists with the
  // buffering accessors — eagerly marking `stream()` as counted would let a
  // double `stream()` read double-count, and an opened-but-unread stream
  // suppress the count of a later `text()` that did read the bytes.
  let claimedBy: "none" | "buffered" | number = "none";
  let nextStreamId = 0;
  const countBuffered = (bytes: number): void => {
    if (claimedBy === "none") {
      claimedBy = "buffered";
      add(bytes);
    }
  };
  return {
    arrayBuffer: async () => {
      const buffer = await file.arrayBuffer();
      countBuffered(buffer.byteLength);
      return buffer;
    },
    blob: async () => {
      const blob = await file.blob();
      countBuffered(blob.size);
      return blob;
    },
    etag: file.etag,
    key: file.key,
    lastModified: file.lastModified,
    metadata: file.metadata,
    name: file.name,
    size: file.size,
    stream: () => {
      const id = nextStreamId;
      nextStreamId += 1;
      return file.stream().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (claimedBy === "none") {
              claimedBy = id;
            }
            if (claimedBy === id) {
              add(chunk.byteLength);
            }
            controller.enqueue(chunk);
          },
        })
      );
    },
    text: async () => {
      const text = await file.text();
      countBuffered(file.size);
      return text;
    },
    type: file.type,
  };
};

/**
 * Meter storage, bandwidth, and operation counts across a {@link Files}
 * instance, and surface the running totals via `files.usage()`. Every operation
 * is counted once; `upload` adds its result size to `bytesUp`, and `download` /
 * `head` wrap the returned body so the bytes you actually read add to
 * `bytesDown` — the lazy, stream-level accounting a fire-and-forget
 * {@link FilesHooks} `onAction` can't do. Pass {@link UsageOptions.group} to
 * break the totals down per tenant or prefix.
 *
 * Body-transparent: it never buffers, transforms, or reads the body itself
 * (`bytesDown` is tallied only when *you* consume it), so streaming, range
 * downloads, `url()`, and `signedUploadUrl()` all keep working. It uses no
 * metadata and no native deps, so it works on any adapter.
 *
 * Plugins run **outside** retries, so a call counts as one operation no matter
 * how many times it's retried, and a call that throws isn't counted at all.
 * Place `usage()` **first** (outermost) so it meters caller-facing operations
 * and logical bytes: a later body-transforming plugin (`compression()`,
 * `encryption()`) reports the logical size up the chain, and the internal
 * sub-operations a plugin like `dedup()` issues stay below it, unmetered.
 * Placed last (innermost) it instead meters the bytes-on-the-wire to the
 * provider and the provider operations those plugins expand into.
 *
 * @param options optional `{ group }` — bucket usage per tenant/prefix.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { usage } from "files-sdk/usage";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [usage()],
 * });
 *
 * await files.upload("a.txt", "hello");
 * await (await files.download("a.txt")).text();
 * files.usage(); // { operations: 2, bytesUp: 5, bytesDown: 5, operationsByKind: {…} }
 * ```
 */
export const usage = (options: UsageOptions = {}): FilesPlugin<UsageApi> => {
  const groupOf = options.group ?? (() => DEFAULT_GROUP);
  const groups = new Map<string, UsageStats>();
  const bucketFor = (key: string): UsageStats => {
    let stats = groups.get(key);
    if (!stats) {
      stats = emptyStats();
      groups.set(key, stats);
    }
    return stats;
  };

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    // Resolve the group before the call (the op may be transformed inward) but
    // count only on success — a thrown/vetoed op moved nothing.
    const key = groupOf(op);
    const result = await next(op);
    const stats = bucketFor(key);
    stats.operations += 1;
    stats.operationsByKind[op.kind] += 1;
    if (op.kind === "upload") {
      stats.bytesUp += (result as UploadResult).size ?? 0;
      return result;
    }
    if (op.kind === "download" || op.kind === "head") {
      // Re-resolve the bucket at flow time so bytes land in the current window
      // even if `resetUsage()` ran between dispatch and the body being read.
      return meterRead(result as StoredFile, (bytes) => {
        bucketFor(key).bytesDown += bytes;
      });
    }
    return result;
  }) as NonNullable<FilesPlugin["wrap"]>;

  return {
    extend: () => ({
      resetUsage: () => groups.clear(),
      usage: () => aggregate(groups.values()),
      usageByGroup: () => {
        const out: Record<string, UsageStats> = {};
        for (const [key, stats] of groups) {
          out[key] = snapshot(stats);
        }
        return out;
      },
    }),
    name: "usage",
    wrap,
  };
};
