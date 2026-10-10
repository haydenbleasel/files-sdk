import { isConditionalOperation, rejectConditional } from "../index.js";
import type {
  FileInfo,
  Files,
  FilesOperation,
  FilesPlugin,
  ListOptions,
  ListResult,
  OperationResult,
  PluginNext,
} from "../index.js";
import { FilesError } from "../internal/errors.js";
import { reserveKeyPrefix } from "../internal/files-router/reserved.js";
import { resolvesUnder } from "../internal/key-prefix.js";

/**
 * A trashed object, as returned by {@link SoftDeleteApi.trashed}. Pass its
 * {@link TrashedFile.key} (the original, live key) back to
 * {@link SoftDeleteApi.restoreTrashed} to bring it back, or
 * {@link SoftDeleteApi.purge} to delete it for good.
 */
export interface TrashedFile {
  /** The original key the object was deleted from — hand it to `restoreTrashed()` / `purge()`. */
  key: string;
  /** The underlying storage key the trashed copy lives at, under the trash prefix. */
  trashKey: string;
  /** Byte length of the trashed object. */
  size: number;
  /**
   * The trashed copy's last-modified time (ms epoch), when the adapter reports
   * one. On most adapters a soft delete is a server-side copy, so this is
   * roughly when the object was trashed.
   */
  lastModified?: number;
  /** The trashed copy's ETag, when the adapter reports one. */
  etag?: string;
}

/** Options for {@link SoftDeleteApi.trashed}. */
export interface TrashedOptions {
  /**
   * Only list trashed objects whose original key starts with this prefix —
   * the walk itself is bounded to it, so a per-tenant view (`"users/42/"`)
   * never reads anyone else's trash.
   */
  prefix?: string;
}

/**
 * The methods {@link softDelete} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type SoftDeleteApi = {
  /**
   * List everything currently in the trash — or, with `prefix`, only what was
   * deleted from under it — each entry carrying the original `key` you'd pass
   * to {@link SoftDeleteApi.restoreTrashed}. Returns an empty array when
   * nothing matches.
   */
  trashed: (options?: TrashedOptions) => Promise<TrashedFile[]>;
  /**
   * Bring a soft-deleted object back to its original key, removing it from the
   * trash. Resolves to the restored key's {@link FileInfo} (via `head`). Throws
   * when nothing is trashed for `key`. A live object at `key` (e.g. one
   * re-created after the delete) is overwritten.
   */
  restoreTrashed: (key: string) => Promise<FileInfo>;
  /**
   * Permanently delete a trashed object — the one for `key`, or the **entire**
   * trash when `key` is omitted. Idempotent: purging a key with nothing trashed
   * is a no-op. This is the only way the data actually leaves storage. A
   * whole-trash purge removes everything it can and then throws (carrying the
   * first failure as `cause`) when any trashed object couldn't be deleted.
   */
  purge: (key?: string) => Promise<void>;
};

export interface SoftDeleteOptions {
  /**
   * Where deleted objects are moved, as a key prefix. Defaults to `".trash"`.
   * A delete of `photos/a.jpg` relocates it to `".trash/photos/a.jpg"`. Objects
   * under this prefix are hidden from `list()` (unless you list within it) and a
   * `delete` of one is a **real** delete — that's how `purge()` works. Don't
   * store your own data under it.
   */
  prefix?: string;
}

const isNotFound = (cause: unknown): boolean =>
  cause instanceof FilesError && cause.code === "NotFound";

/**
 * Collapse leading/trailing slashes the way the SDK treats keys. The negative
 * lookbehind anchors the trailing run to its first slash so the match can't
 * backtrack across `"a////"` (the ReDoS shape a bare `\/+$` has).
 */
const normalizeDir = (prefix: string): string => {
  const normalized = prefix.replaceAll(/^\/+|(?<!\/)\/+$/gu, "");
  if (normalized.length === 0) {
    throw new FilesError(
      "Invalid",
      "softDelete: prefix must not be empty or all slashes"
    );
  }
  return normalized;
};

/**
 * Turn `delete` into a recoverable move into a trash prefix, and add `trashed()`
 * / `restoreTrashed()` / `purge()` so you can list, recover, and permanently remove
 * what's been deleted. Instead of destroying an object, a `delete` server-side
 * **moves** it to a time-of-deletion copy under a trash prefix (`.trash/` by
 * default); the bytes only ever leave storage when you `purge()`.
 *
 * Like `versioning()`, it's **body-transparent** — it never buffers, transforms,
 * or reads the body, so streaming, range downloads, `url()`, and
 * `signedUploadUrl()` all keep working — and it has **no native dependencies**.
 * Because it relocates whatever the rest of the pipeline stored, place it
 * **first** (outermost): `plugins: [softDelete(), encryption(key)]`.
 *
 * It uses `extend`, so reach for {@link createFiles} to surface
 * `files.trashed()` / `files.restoreTrashed()` / `files.purge()` on the type.
 *
 * Trade-offs, by design:
 * - **One copy per key.** A delete relocates to `"<prefix>/<key>"`, so deleting
 *   a key whose trashed copy still exists **replaces** that copy (latest delete
 *   wins). Reach for `versioning()` if you need every deleted generation kept.
 *   On a hierarchical store (fs, SFTP, …) a trashed `a` and a trashed `a/b`
 *   can't coexist, so the second delete throws a `Conflict` naming the
 *   trashed entry to `purge()` first.
 * - **`delete` becomes a `copy` + `delete`.** A soft delete is a move, so it
 *   costs an extra round-trip versus a hard delete. Deleting a key that doesn't
 *   exist stays a no-op, the same as a plain `delete`.
 * - **Only deletes through the instance are trashed.** Overwrites (including
 *   presigned uploads) and deletes made directly against the provider aren't —
 *   reach for `versioning()` to keep overwritten bytes. It's a safety net, not
 *   a security control, so it doesn't fail closed the way `validation()` does.
 * - **Trash grows until you `purge()`.** Nothing expires on its own.
 * - **Pairs with `versioning()`, versioning outermost.** Put `versioning()`
 *   before this plugin so deletes are snapshotted, and hand it the trash prefix
 *   as `ignore` so a `purge()` isn't itself versioned:
 *   `plugins: [versioning({ ignore: [".trash"] }), softDelete()]`.
 *
 * @param options optional `{ prefix }` — where trashed objects live.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { softDelete } from "files-sdk/soft-delete";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [softDelete()],
 * });
 *
 * await files.upload("notes.txt", "hi");
 * await files.delete("notes.txt"); // moved to .trash/notes.txt, not destroyed
 *
 * await files.trashed(); // [{ key: "notes.txt", trashKey: ".trash/notes.txt", … }]
 * await files.restoreTrashed("notes.txt"); // back to "notes.txt"
 * await files.delete("notes.txt");
 * await files.purge("notes.txt"); // now it's really gone
 * ```
 */
export const softDelete = (
  options: SoftDeleteOptions = {}
): FilesPlugin<SoftDeleteApi> => {
  const trashDir = normalizeDir(options.prefix ?? ".trash");

  const trashKeyFor = (key: string): string => `${trashDir}/${key}`;
  /**
   * Whether a key lives in the trash store — deletes of those are real. The
   * spelling must match exactly: on a case-sensitive store `.TRASH/x` is a
   * live key of its own, and hard-deleting it would bypass the trash. It must
   * also *stay* inside once resolved, so `.trash/../notes.txt` (which a
   * filesystem resolves to `notes.txt`) is trashed, not hard-deleted.
   */
  const isTrashKey = (key: string): boolean =>
    (key === trashDir || key.startsWith(`${trashDir}/`)) &&
    resolvesUnder(key, trashDir);

  /**
   * The trash key for a caller's original key, refusing one that resolves out
   * of the trash (`../notes.txt`): `purge()` would otherwise hard-delete, and
   * `restoreTrashed()` move, a live object.
   */
  const trashKeyOf = (key: string): string => {
    const trashKey = trashKeyFor(key);
    if (!isTrashKey(trashKey)) {
      throw new FilesError(
        "Invalid",
        `softDelete: "${key}" resolves outside the trash ("${trashDir}"); pass the original key of a trashed object`
      );
    }
    return trashKey;
  };

  /** The refusal naming the trashed entry that blocks trashing `key`. */
  const collision = (
    key: string,
    blocker: string,
    cause: FilesError
  ): FilesError =>
    new FilesError(
      "Conflict",
      `softDelete: can't move "${key}" to the trash — the trashed copy of "${blocker}" ("${trashKeyFor(blocker)}") is in its way on this hierarchical store, where a trashed key and a trashed key nested under it can't coexist. purge("${blocker}") (or restoreTrashed("${blocker}")) and delete "${key}" again.`,
      cause
    );

  /**
   * Explain a `Conflict` from the move into the trash. On a hierarchical store
   * (fs, SFTP, …) a trashed `a` is a file where trashing `a/b` needs a
   * folder, and a trashed `a/b` makes `.trash/a` a folder a trashed `a` can't
   * replace. Find the trashed entry in the way and name it; when there's
   * none (or looking fails), the original error stands.
   */
  const explainConflict = async (
    key: string,
    next: PluginNext,
    cause: FilesError
  ): Promise<FilesError> => {
    try {
      const segments = key.split("/");
      for (let end = 1; end < segments.length; end += 1) {
        const ancestor = segments.slice(0, end).join("/");
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- nearest ancestor first; stops at the first trashed one.
        if (await next({ key: trashKeyFor(ancestor), kind: "exists" })) {
          return collision(key, ancestor, cause);
        }
      }
      const { items } = await next({
        kind: "list",
        options: { limit: 1, prefix: `${trashKeyFor(key)}/` },
      });
      const [nested] = items;
      return nested
        ? collision(key, nested.key.slice(trashDir.length + 1), cause)
        : cause;
    } catch {
      return cause;
    }
  };

  /**
   * Hide trashed objects from listings, so a soft delete doesn't leave the key
   * lingering in `list()` — unless the caller is explicitly listing within the
   * trash prefix (which is how `trashed()` reads them). Filtering keeps the
   * page's `cursor`, so pagination still resumes correctly; pages may just come
   * back shorter.
   */
  const hideTrash = (
    result: ListResult,
    listOptions: ListOptions | undefined
  ): ListResult => {
    const requested = listOptions?.prefix;
    if (
      requested !== undefined &&
      (requested === trashDir || requested.startsWith(`${trashDir}/`))
    ) {
      return result;
    }
    const marker = `${trashDir}/`;
    const items = result.items.filter((file) => !file.key.startsWith(marker));
    const prefixes = result.prefixes?.filter(
      (entry) => !entry.startsWith(marker)
    );
    if (
      items.length === result.items.length &&
      (prefixes?.length ?? 0) === (result.prefixes?.length ?? 0)
    ) {
      return result;
    }
    return {
      items,
      ...(result.cursor !== undefined && { cursor: result.cursor }),
      ...(prefixes && prefixes.length > 0 && { prefixes }),
    };
  };

  const listTrashed = async (
    files: Files,
    keyPrefix = ""
  ): Promise<TrashedFile[]> => {
    const out: TrashedFile[] = [];
    for await (const item of files.listAll({
      prefix: `${trashDir}/${keyPrefix}`,
    })) {
      out.push({
        key: item.key.slice(trashDir.length + 1),
        size: item.size,
        trashKey: item.key,
        ...(item.lastModified !== undefined && {
          lastModified: item.lastModified,
        }),
        ...(item.etag !== undefined && { etag: item.etag }),
      });
    }
    return out;
  };

  const restore = async (files: Files, key: string): Promise<FileInfo> => {
    const trashKey = trashKeyOf(key);
    if (!(await files.exists(trashKey))) {
      throw new FilesError(
        "NotFound",
        `softDelete: nothing trashed for "${key}"`
      );
    }
    // A move out of the trash: the source is a trash key (passed through, not
    // re-trashed), and restoring removes the copy from the trash.
    await files.move(trashKey, key);
    return files.head(key);
  };

  const purge = async (files: Files, key?: string): Promise<void> => {
    if (key !== undefined) {
      // A delete of a trash key is a real delete. Purge is idempotent, but an
      // adapter may throw `NotFound` for a missing key (GCS, Firebase) rather
      // than no-op, so nothing trashed is no error either way.
      const trashKey = trashKeyOf(key);
      try {
        await files.delete(trashKey);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      return;
    }
    const keys: string[] = [];
    for await (const item of files.listAll({ prefix: `${trashDir}/` })) {
      keys.push(item.key);
    }
    if (keys.length === 0) {
      return;
    }
    // The bulk delete never throws — it collects per-key failures — so surface
    // them here, or a purge would resolve while trashed() still lists the key.
    // Every deletable key is still removed first (no `stopOnError`).
    // A `NotFound` means the object is already gone (purged concurrently, on
    // an adapter that reports a missing key rather than no-op), which is
    // what a purge wants.
    const outcome = await files.delete(keys);
    const errors = (outcome.errors ?? []).filter(
      (failure) => !isNotFound(failure.error)
    );
    const [first] = errors;
    if (first) {
      throw new FilesError(
        first.error.code,
        `softDelete: purge failed for ${String(errors.length)} of ${String(keys.length)} trashed object(s); first failure at "${first.key}": ${first.error.message}`,
        first.error
      );
    }
  };

  // SAFETY: the engine folds `wrap` over the erased `FilesOperation` union and
  // re-narrows the result per call; every branch below resolves with the value
  // the matching verb's `next` produces (a re-routed delete resolves to
  // `undefined`, as a delete does), so the non-generic function satisfies the
  // generic `wrap` at each verb.
  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<OperationResult<FilesOperation>> => {
    switch (op.kind) {
      case "delete": {
        // A delete inside the trash is a real delete — this is how `purge()`
        // and any manual trash cleanup actually remove bytes. It is forwarded
        // unchanged, so a conditional one keeps its native compare-and-set
        // (useful for purging one trashed generation atomically against a
        // concurrent restore).
        if (isTrashKey(op.key)) {
          return next(op);
        }
        // Outside the trash a delete becomes a move, and no single native
        // predicate spans that copy + delete, so the mode is vetoed.
        if (isConditionalOperation(op)) {
          rejectConditional(
            op,
            "soft-delete",
            "trash routing cannot preserve the native compare-and-set"
          );
        }
        try {
          // Thread the caller's options through — the re-routed move IS the
          // user's delete, so its `signal`/`timeout`/`retries` must apply.
          await next({
            from: op.key,
            kind: "move",
            options: op.options,
            to: trashKeyFor(op.key),
          });
        } catch (error) {
          // Deleting a key that doesn't exist is a no-op, same as a plain
          // delete; the move's copy step is what surfaces a missing source.
          if (isNotFound(error)) {
            return;
          }
          if (error instanceof FilesError && error.code === "Conflict") {
            throw await explainConflict(op.key, next, error);
          }
          throw error;
        }
        return;
      }
      case "list": {
        return hideTrash(await next(op), op.options);
      }
      default: {
        return next(op);
      }
    }
  }) as NonNullable<FilesPlugin["wrap"]>;

  return {
    // Advertise what the wrap refuses: a conditional delete outside the trash
    // becomes a move no native predicate spans, so it's vetoed, and callers
    // branching on `files.capabilities` shouldn't plan one.
    capabilities: (caps) => ({
      ...caps,
      conditional: { ...caps.conditional, delete: false },
    }),
    // Provider events: a soft delete arrives as the key's `deleted` plus a
    // `created` in the trash, and a restore the other way round; the trash
    // side is internal.
    event: (event) => (isTrashKey(event.key) ? null : event),
    extend: (files) => {
      // The trash is plugin-private: `files-sdk/api` refuses client keys
      // inside it, so a gateway that allows `delete` but not `purge` can't
      // hard-delete a trashed object through the core verb.
      reserveKeyPrefix(files, "soft-delete", trashDir);
      return {
        purge: (key) => purge(files, key),
        restoreTrashed: (key) => restore(files, key),
        trashed: (opts) => listTrashed(files, opts?.prefix),
      };
    },
    name: "soft-delete",
    wrap,
  };
};
