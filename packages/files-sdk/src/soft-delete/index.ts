import type {
  Files,
  FilesOperation,
  FilesPlugin,
  ListOptions,
  ListResult,
  PluginNext,
  StoredFile,
} from "../index.js";
import { FilesError } from "../internal/errors.js";

/**
 * A trashed object, as returned by {@link SoftDeleteApi.trashed}. Pass its
 * {@link TrashedFile.key} (the original, live key) back to
 * {@link SoftDeleteApi.restore} to bring it back, or
 * {@link SoftDeleteApi.purge} to delete it for good.
 */
export interface TrashedFile {
  /** The original key the object was deleted from — hand it to `restore()` / `purge()`. */
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

/**
 * The methods {@link softDelete} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type SoftDeleteApi = {
  /**
   * List everything currently in the trash, each entry carrying the original
   * `key` you'd pass to {@link SoftDeleteApi.restore}. Returns an empty array
   * when the trash is empty.
   */
  trashed(): Promise<TrashedFile[]>;
  /**
   * Bring a soft-deleted object back to its original key, removing it from the
   * trash. Resolves to the restored {@link StoredFile} (via `head`). Throws when
   * nothing is trashed for `key`. A live object at `key` (e.g. one re-created
   * after the delete) is overwritten.
   */
  restore(key: string): Promise<StoredFile>;
  /**
   * Permanently delete a trashed object — the one for `key`, or the **entire**
   * trash when `key` is omitted. Idempotent: purging a key with nothing trashed
   * is a no-op. This is the only way the data actually leaves storage.
   */
  purge(key?: string): Promise<void>;
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

/**
 * Collapse leading/trailing slashes the way the SDK treats keys. The negative
 * lookbehind anchors the trailing run to its first slash so the match can't
 * backtrack across `"a////"` (the ReDoS shape a bare `\/+$` has).
 */
const normalizeDir = (prefix: string): string => {
  const normalized = prefix.replaceAll(/^\/+|(?<!\/)\/+$/gu, "");
  if (normalized.length === 0) {
    throw new FilesError(
      "Provider",
      "softDelete: prefix must not be empty or all slashes"
    );
  }
  return normalized;
};

/**
 * Turn `delete` into a recoverable move into a trash prefix, and add `trashed()`
 * / `restore()` / `purge()` so you can list, recover, and permanently remove
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
 * `files.trashed()` / `files.restore()` / `files.purge()` on the type.
 *
 * Trade-offs, by design:
 * - **One copy per key.** A delete relocates to `"<prefix>/<key>"`, so deleting
 *   a key whose trashed copy still exists **replaces** that copy (latest delete
 *   wins). Reach for `versioning()` if you need every deleted generation kept.
 * - **`delete` becomes a `copy` + `delete`.** A soft delete is a move, so it
 *   costs an extra round-trip versus a hard delete. Deleting a key that doesn't
 *   exist stays a no-op, the same as a plain `delete`.
 * - **Direct presigned writes bypass it.** Only deletes through the instance are
 *   trashed; it's a safety net, not a security control, so it doesn't fail
 *   closed the way `validation()` does.
 * - **Trash grows until you `purge()`.** Nothing expires on its own.
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
 * await files.restore("notes.txt"); // back to "notes.txt"
 * await files.delete("notes.txt");
 * await files.purge("notes.txt"); // now it's really gone
 * ```
 */
export const softDelete = (
  options: SoftDeleteOptions = {}
): FilesPlugin<SoftDeleteApi> => {
  const trashDir = normalizeDir(options.prefix ?? ".trash");

  const trashKeyFor = (key: string): string => `${trashDir}/${key}`;
  /** Whether a key lives in the trash store — deletes of those are real. */
  const isTrashKey = (key: string): boolean =>
    key === trashDir || key.startsWith(`${trashDir}/`);

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

  const listTrashed = async (files: Files): Promise<TrashedFile[]> => {
    const out: TrashedFile[] = [];
    for await (const item of files.listAll({ prefix: `${trashDir}/` })) {
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

  const restore = async (files: Files, key: string): Promise<StoredFile> => {
    const trashKey = trashKeyFor(key);
    if (!(await files.exists(trashKey))) {
      throw new FilesError(
        "Provider",
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
      // A delete of a trash key is a real delete (idempotent if already gone).
      await files.delete(trashKeyFor(key));
      return;
    }
    const keys: string[] = [];
    for await (const item of files.listAll({ prefix: `${trashDir}/` })) {
      keys.push(item.key);
    }
    if (keys.length > 0) {
      await files.delete(keys);
    }
  };

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    switch (op.kind) {
      case "delete": {
        // A delete inside the trash is a real delete — this is how `purge()`
        // and any manual trash cleanup actually remove bytes.
        if (isTrashKey(op.key)) {
          return next(op);
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
          if (error instanceof FilesError && error.code === "NotFound") {
            return;
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
    extend: (files) => ({
      purge: (key) => purge(files, key),
      restore: (key) => restore(files, key),
      trashed: () => listTrashed(files),
    }),
    name: "soft-delete",
    wrap,
  };
};
