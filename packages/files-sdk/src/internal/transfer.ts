// Cross-provider transfer: stream every object under a prefix from one
// `Files` instance to another. This is the one operation the unified surface
// uniquely enables — `copy`/`move` live inside a single adapter, but a
// migration (S3 → R2, fs → GCS, …) spans two backends that share nothing but
// this SDK's API. It's built entirely on public primitives: the source's
// `listAll` + streaming `download`, the destination's `exists` + `upload`. No
// adapter has to implement anything new.

import type { BulkError, BulkOptions, Files, ListOptions } from "../index.js";
import { mapMany } from "./core.js";

/**
 * A single per-key report, delivered to {@link TransferOptions.onProgress}
 * once a key has been transferred or skipped (failures surface in the result's
 * `errors`, not here).
 */
export interface TransferProgress {
  /** Keys settled so far — transferred plus skipped. Monotonically increasing. */
  done: number;
  /** Total keys the source walk turned up — the denominator for `done`. */
  total: number;
  /** The source key just settled. */
  key: string;
  /** Whether the key was copied to the destination or skipped (already present and `overwrite: false`). */
  status: "transferred" | "skipped";
}

export interface TransferOptions extends BulkOptions {
  /**
   * Only transfer keys under this prefix. Forwarded to `source.listAll`, so
   * it's scoped on top of the source instance's own `prefix`.
   */
  prefix?: string;
  /**
   * Map each source key to its destination key. Defaults to identity (the
   * same key on both sides). Both sides are *logical* keys — each instance
   * applies its own `prefix` independently, so this maps the un-prefixed key.
   */
  transformKey?: (key: string) => string;
  /**
   * When `false`, skip any key that already exists at the destination rather
   * than overwriting it. Costs one extra `exists()` per key. Defaults to
   * `true` (overwrite).
   */
  overwrite?: boolean;
  /**
   * Page size for the underlying `source.listAll` walk — how many keys each
   * `list` call fetches, not a cap on the total transferred.
   */
  limit?: number;
  /** Called once per key after it settles. See {@link TransferProgress}. */
  onProgress?: (progress: TransferProgress) => void;
  /**
   * Abort the transfer. Forwarded to every `list` / `exists` / `download` /
   * `upload`. Aborting during the source walk rejects the call; aborting
   * during the transfer phase surfaces the cancelled keys in `errors`.
   */
  signal?: AbortSignal;
}

export interface TransferResult {
  /** Source keys copied to the destination, in walk order. */
  transferred: string[];
  /** Source keys skipped because they already existed (`overwrite: false`). Omitted when none. */
  skipped?: string[];
  /** Per-key failures, each a normalized `FilesError`. Omitted when every key succeeded. */
  errors?: BulkError[];
}

const identity = (key: string): string => key;

/**
 * Copy every object the `source` exposes (optionally under `prefix`) to the
 * `dest`, streaming each body straight through — the destination never sees a
 * buffered copy of a large object. Both arguments are full {@link Files}
 * instances, so each leg honors its own instance's `prefix`, retries,
 * timeouts, and hooks.
 *
 * Like the bulk array methods, this does **not** throw on a partial failure:
 * successes land in `transferred`, per-key failures in `errors`, both in walk
 * order. Pass `stopOnError` to bail at the first failure (sequential), or
 * `overwrite: false` to skip keys already present at the destination.
 *
 * ```ts
 * import { Files, transfer } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { r2 } from "files-sdk/r2";
 *
 * const from = new Files({ adapter: s3({ bucket: "old" }) });
 * const to = new Files({ adapter: r2({ bucket: "new", ... }) });
 *
 * const { transferred, errors } = await transfer(from, to, {
 *   prefix: "uploads/",
 *   onProgress: ({ done, total, key }) => console.log(`${done}/${total}`, key),
 * });
 * ```
 *
 * The source is walked in full before transfers begin (so `total` is known),
 * but only the keys are buffered — every body still streams. Only the body,
 * content type, and user metadata travel with each object; destination-assigned
 * fields (`etag`, `lastModified`) are fresh, and `Cache-Control` is not carried
 * (a `StoredFile` doesn't expose it). Metadata is dropped for adapters with no
 * metadata primitive, and forwarded keys that a destination adapter rejects
 * (e.g. metadata on Bunny/Appwrite/PocketBase) surface as per-key `errors`.
 */
export const transfer = async (
  source: Files,
  dest: Files,
  opts?: TransferOptions
): Promise<TransferResult> => {
  const overwrite = opts?.overwrite ?? true;
  const transformKey = opts?.transformKey ?? identity;
  const onProgress = opts?.onProgress;
  const signalOpt = opts?.signal ? { signal: opts.signal } : {};

  // Walk the source up front. Only keys are buffered (cheap); bodies stream
  // one at a time during the transfer phase below.
  const listOpts: ListOptions = { ...signalOpt };
  if (opts?.prefix !== undefined) {
    listOpts.prefix = opts.prefix;
  }
  if (opts?.limit !== undefined) {
    listOpts.limit = opts.limit;
  }
  const keys: string[] = [];
  for await (const file of source.listAll(listOpts)) {
    keys.push(file.key);
  }
  const total = keys.length;

  let done = 0;
  const skipped = new Set<string>();
  const report = (key: string, status: TransferProgress["status"]): void => {
    done += 1;
    onProgress?.({ done, key, status, total });
  };

  // `mapMany` is the same bounded-concurrency engine the bulk array methods
  // use: input-order results, per-key error collection, `stopOnError`. The
  // run echoes its key on success; skips are tracked separately so the result
  // can split them back out.
  const { results, errors } = await mapMany(
    keys,
    identity,
    async (key) => {
      const destKey = transformKey(key);
      if (!overwrite && (await dest.exists(destKey, signalOpt))) {
        skipped.add(key);
        report(key, "skipped");
        return key;
      }
      const file = await source.download(key, { as: "stream", ...signalOpt });
      const body = file.stream();
      try {
        await dest.upload(destKey, body, {
          contentType: file.type,
          ...(file.metadata ? { metadata: file.metadata } : {}),
          ...signalOpt,
        });
      } catch (error) {
        // The destination failed without draining the source (auth error,
        // rejected metadata, a fail-closed plugin) — cancel the open stream
        // so its HTTP response / file handle is released instead of leaking
        // one per failed key on a large walk. A locked stream is held by the
        // failed consumer; nothing to release here.
        if (!body.locked) {
          try {
            await body.cancel();
          } catch {
            // Best-effort cleanup — the per-key error is what matters.
          }
        }
        throw error;
      }
      report(key, "transferred");
      return key;
    },
    opts
  );

  const transferred: string[] = [];
  const skippedKeys: string[] = [];
  for (const key of results) {
    (skipped.has(key) ? skippedKeys : transferred).push(key);
  }

  const result: TransferResult = { transferred };
  if (skippedKeys.length > 0) {
    result.skipped = skippedKeys;
  }
  if (errors.length > 0) {
    result.errors = errors;
  }
  return result;
};
