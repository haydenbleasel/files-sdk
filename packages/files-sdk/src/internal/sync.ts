// Cross-provider mirror: reconcile a destination against a source instead of
// blindly copying. Where `transfer` is a one-shot copy, `sync` adds the three
// things a backup or incremental migration actually needs — skip objects that
// are already identical at the destination, optionally prune destination keys
// the source no longer has, and preview the whole plan with `dryRun`. Like
// `transfer` it spans two backends and is built entirely on public primitives:
// both instances' `listAll`, the source's streaming `download`, the
// destination's `upload` + bulk `delete`. No adapter implements anything new.
//
// The comparison runs off the metadata `list` already returns (size + etag),
// so the destination is walked exactly once — that same walk drives the prune,
// so the size/etag check is free. Callers who only want the cheap per-key path
// with no prune already have `transfer(overwrite: false)`.

import type {
  BulkError,
  BulkOptions,
  Files,
  ListOptions,
  StoredFile,
} from "../index.js";
import { mapMany } from "./core.js";

/**
 * How `sync` decides a destination object is already up to date — the predicate
 * that splits the source walk into uploads vs. skips.
 *
 * - `"etag"` (the default) — unchanged when size **and** etag both match. etags
 *   are only comparable within one scheme: S3↔S3 single-part uploads match, but
 *   across heterogeneous backends (S3 → R2 / GCS / Azure) or for multipart
 *   objects they differ even for identical bytes, so the object is conservatively
 *   re-uploaded. A missing etag on either side counts as changed.
 * - `"size"` — unchanged when byte length matches. Comparable across every
 *   backend, but blind to same-size edits; the right default for cross-provider
 *   mirrors.
 * - a function — full control. Receives the source and destination
 *   {@link StoredFile} metadata and returns `true` when the object should be
 *   skipped (treated as unchanged).
 *
 * `lastModified` is deliberately not used: the destination stamps its own upload
 * time, so it never matches the source after a sync — comparing it would
 * re-upload everything on every run.
 */
export type SyncCompare =
  | "etag"
  | "size"
  | ((source: StoredFile, dest: StoredFile) => boolean);

/**
 * A single per-key report, delivered to {@link SyncOptions.onProgress} once a
 * key has settled (failures surface in the result's `errors`, not here). Skips
 * are reported first, then uploads as each streams through, then prunes.
 */
export interface SyncProgress {
  /** Keys settled so far — uploaded plus skipped plus deleted. Monotonically increasing. */
  done: number;
  /** Uploads, skips, and prunes the plan turned up — the denominator for `done`. */
  total: number;
  /** The source key (upload / skip) or destination key (delete) just settled. */
  key: string;
  /** What happened to the key. */
  status: "uploaded" | "skipped" | "deleted";
}

export interface SyncOptions extends BulkOptions {
  /**
   * Only mirror keys under this prefix. Forwarded to `source.listAll`, so it's
   * scoped on top of the source instance's own `prefix`. Also the default scope
   * for the destination walk — see `destPrefix`.
   */
  prefix?: string;
  /**
   * Scope the destination walk (the comparison + prune set) to this prefix.
   * Defaults to `prefix`. Set it when `transformKey` re-homes keys under a
   * different namespace, so prune only ever considers the mirror's own keys.
   */
  destPrefix?: string;
  /**
   * Map each source key to its destination key. Defaults to identity (the same
   * key on both sides). Both sides are *logical* keys — each instance applies
   * its own `prefix` independently, so this maps the un-prefixed key.
   */
  transformKey?: (key: string) => string;
  /**
   * Mirror mode: after uploading, delete destination keys that no source key
   * maps onto. **Destructive** — an empty source prunes the entire destination
   * scope. Defaults to `false`.
   */
  prune?: boolean;
  /**
   * Change detection — how an existing destination object is judged up to date.
   * See {@link SyncCompare}. Defaults to `"etag"`.
   */
  compare?: SyncCompare;
  /**
   * Compute the full reconciliation plan (`uploaded` / `skipped` / `deleted`)
   * without uploading or deleting anything. `onProgress` does not fire — nothing
   * settled. Defaults to `false`.
   */
  dryRun?: boolean;
  /**
   * Page size for the underlying `listAll` walks of both sides — how many keys
   * each `list` call fetches, not a cap on the total mirrored.
   */
  limit?: number;
  /** Called once per key after it settles. See {@link SyncProgress}. */
  onProgress?: (progress: SyncProgress) => void;
  /**
   * Abort the sync. Forwarded to every `list` / `download` / `upload` (the bulk
   * `delete` carries no signal). Aborting during a walk rejects the call;
   * aborting during the upload phase surfaces the cancelled keys in `errors`.
   */
  signal?: AbortSignal;
}

export interface SyncResult {
  /** Source keys written to the destination (new or changed), in walk order. */
  uploaded: string[];
  /** Source keys left untouched because the destination copy was up to date. */
  skipped: string[];
  /** Destination keys pruned. Present only when `prune` is set (even if empty). */
  deleted?: string[];
  /** Per-key failures (uploads and prunes), each a normalized `FilesError`. Omitted when none. */
  errors?: BulkError[];
}

const identity = (key: string): string => key;

const unchanged = (
  source: StoredFile,
  dest: StoredFile,
  compare: SyncCompare
): boolean => {
  if (typeof compare === "function") {
    return compare(source, dest);
  }
  if (compare === "size") {
    return source.size === dest.size;
  }
  // "etag": size and etag must both match. A missing etag on either side is
  // treated as changed rather than guessed equal.
  return (
    source.size === dest.size &&
    source.etag !== undefined &&
    dest.etag !== undefined &&
    source.etag === dest.etag
  );
};

const buildWalkOptions = (
  signalOpt: { signal?: AbortSignal },
  prefix: string | undefined,
  limit: number | undefined
): ListOptions => {
  const walk: ListOptions = { ...signalOpt };
  if (prefix !== undefined) {
    walk.prefix = prefix;
  }
  if (limit !== undefined) {
    walk.limit = limit;
  }
  return walk;
};

const walkAll = async (
  files: Files,
  walk: ListOptions
): Promise<StoredFile[]> => {
  const out: StoredFile[] = [];
  for await (const file of files.listAll(walk)) {
    out.push(file);
  }
  return out;
};

const indexByKey = (files: StoredFile[]): Map<string, StoredFile> => {
  const index = new Map<string, StoredFile>();
  for (const file of files) {
    index.set(file.key, file);
  }
  return index;
};

// Split the source walk into the keys to upload vs. skip — used to preview the
// plan under `dryRun`.
const partition = (
  sources: StoredFile[],
  destIndex: Map<string, StoredFile>,
  transformKey: (key: string) => string,
  compare: SyncCompare
): { uploads: string[]; skips: string[] } => {
  const uploads: string[] = [];
  const skips: string[] = [];
  for (const file of sources) {
    const existing = destIndex.get(transformKey(file.key));
    (existing && unchanged(file, existing, compare) ? skips : uploads).push(
      file.key
    );
  }
  return { skips, uploads };
};

// Destination keys no source key maps onto — the prune set. Independent of the
// change comparison; computed from the key sets alone.
const extraneousKeys = (
  sources: StoredFile[],
  destIndex: Map<string, StoredFile>,
  transformKey: (key: string) => string
): string[] => {
  const wanted = new Set(sources.map((file) => transformKey(file.key)));
  return [...destIndex.keys()].filter((key) => !wanted.has(key));
};

interface UploadContext {
  transformKey: (key: string) => string;
  compare: SyncCompare;
  destIndex: Map<string, StoredFile>;
  signalOpt: { signal?: AbortSignal };
  report: (key: string, status: SyncProgress["status"]) => void;
  opts: SyncOptions | undefined;
}

// One bounded-concurrency pass over the source: each key is either skipped
// (already up to date) or streamed across. `mapMany` echoes the key on success;
// skips are tracked separately so the result can split them back out.
const runUploads = async (
  source: Files,
  dest: Files,
  sources: StoredFile[],
  ctx: UploadContext
): Promise<{ uploaded: string[]; skipped: string[]; errors: BulkError[] }> => {
  const skippedSet = new Set<string>();
  const { results, errors } = await mapMany(
    sources,
    (file) => file.key,
    async (file) => {
      const destKey = ctx.transformKey(file.key);
      const existing = ctx.destIndex.get(destKey);
      if (existing && unchanged(file, existing, ctx.compare)) {
        skippedSet.add(file.key);
        ctx.report(file.key, "skipped");
        return file.key;
      }
      const body = await source.download(file.key, {
        as: "stream",
        ...ctx.signalOpt,
      });
      const stream = body.stream();
      try {
        await dest.upload(destKey, stream, {
          contentType: body.type,
          ...(body.metadata ? { metadata: body.metadata } : {}),
          ...ctx.signalOpt,
        });
      } catch (error) {
        // The destination failed without draining the source — cancel the
        // open stream so its HTTP response / file handle is released instead
        // of leaking one per failed key. A locked stream is held by the
        // failed consumer; nothing to release here.
        if (!stream.locked) {
          try {
            await stream.cancel();
          } catch {
            // Best-effort cleanup — the per-key error is what matters.
          }
        }
        throw error;
      }
      ctx.report(file.key, "uploaded");
      return file.key;
    },
    ctx.opts
  );

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const key of results) {
    (skippedSet.has(key) ? skipped : uploaded).push(key);
  }
  return { errors: [...errors], skipped, uploaded };
};

const runPrune = async (
  dest: Files,
  keys: string[],
  opts: SyncOptions | undefined,
  report: (key: string, status: SyncProgress["status"]) => void
): Promise<{ deleted: string[]; errors: BulkError[] }> => {
  const res = await dest.delete(keys, {
    ...(opts?.concurrency !== undefined && { concurrency: opts.concurrency }),
    ...(opts?.stopOnError && { stopOnError: true }),
  });
  const { deleted } = res;
  for (const key of deleted) {
    report(key, "deleted");
  }
  return { deleted, errors: res.errors ?? [] };
};

/**
 * Mirror the `source` onto the `dest`: upload every object that's new or
 * changed, skip the ones already identical, and — with `prune` — delete the
 * destination keys the source no longer has. Both arguments are full
 * {@link Files} instances, so each leg honors its own instance's `prefix`,
 * retries, timeouts, and hooks. Changed objects stream download-to-upload, so
 * the destination never sees a buffered copy of a large file.
 *
 * Both sides are walked in full before any work begins (so `total` is known and
 * `dryRun` can report the plan), but only metadata is buffered — every body
 * still streams. Only the body, content type, and user metadata travel with
 * each object, exactly as in {@link transfer}.
 *
 * Like the bulk array methods, this does **not** throw on a partial failure:
 * successes land in `uploaded` / `deleted`, per-key failures in `errors`. Pass
 * `stopOnError` to bail at the first upload failure (sequential; the prune phase
 * is then skipped). Uploads run before prunes, so an interrupted run never
 * leaves the destination missing data it was about to gain.
 *
 * ```ts
 * import { Files, sync } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { r2 } from "files-sdk/r2";
 *
 * const from = new Files({ adapter: s3({ bucket: "live" }) });
 * const to = new Files({ adapter: r2({ bucket: "backup", ... }) });
 *
 * // Incremental, pruning mirror — re-running only moves the delta.
 * const { uploaded, deleted } = await sync(from, to, {
 *   prefix: "uploads/",
 *   prune: true,
 *   compare: "size", // cross-provider — etags aren't comparable
 * });
 * ```
 */
export const sync = async (
  source: Files,
  dest: Files,
  opts?: SyncOptions
): Promise<SyncResult> => {
  // Normalize once so the body reads plainly instead of through a forest of
  // `opts?.` chains. `opts` itself is still threaded to the bulk helpers, which
  // forward `concurrency` / `stopOnError` to `mapMany` and `delete`.
  const {
    transformKey = identity,
    compare = "etag",
    prune = false,
    prefix,
    destPrefix = prefix,
    limit,
    signal,
    dryRun,
    onProgress,
    stopOnError,
  } = opts ?? {};
  const signalOpt = signal ? { signal } : {};

  // Walk the source up front (ordered) and index the destination by key. Only
  // metadata is buffered; bodies stream one at a time during the upload phase.
  const sources = await walkAll(
    source,
    buildWalkOptions(signalOpt, prefix, limit)
  );
  const destIndex = indexByKey(
    await walkAll(dest, buildWalkOptions(signalOpt, destPrefix, limit))
  );

  const deleteKeys = prune
    ? extraneousKeys(sources, destIndex, transformKey)
    : [];

  if (dryRun) {
    const { uploads, skips } = partition(
      sources,
      destIndex,
      transformKey,
      compare
    );
    const plan: SyncResult = { skipped: skips, uploaded: uploads };
    if (prune) {
      plan.deleted = deleteKeys;
    }
    return plan;
  }

  const total = sources.length + deleteKeys.length;
  let done = 0;
  const report = (key: string, status: SyncProgress["status"]): void => {
    done += 1;
    onProgress?.({ done, key, status, total });
  };

  const { uploaded, skipped, errors } = await runUploads(
    source,
    dest,
    sources,
    {
      compare,
      destIndex,
      opts,
      report,
      signalOpt,
      transformKey,
    }
  );

  // Prune after uploads. Under `stopOnError` an upload failure bails the run, so
  // the destination is never trimmed against a half-applied source.
  const allErrors = errors;
  let deleted: string[] = [];
  const bailed = stopOnError === true && errors.length > 0;
  if (prune && deleteKeys.length > 0 && !bailed) {
    const { deleted: pruned, errors: pruneErrors } = await runPrune(
      dest,
      deleteKeys,
      opts,
      report
    );
    deleted = pruned;
    allErrors.push(...pruneErrors);
  }

  const result: SyncResult = { skipped, uploaded };
  if (prune) {
    result.deleted = deleted;
  }
  if (allErrors.length > 0) {
    result.errors = allErrors;
  }
  return result;
};
