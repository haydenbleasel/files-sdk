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
 * A saved snapshot of a key, as returned by {@link VersioningApi.versions}.
 * Pass {@link FileVersion.versionId} back to {@link VersioningApi.restore} to
 * roll a key back to this point.
 */
export interface FileVersion {
  /** Opaque, time-ordered id for this version; hand it to `restore()`. */
  versionId: string;
  /** The underlying storage key this snapshot lives at, under the version prefix. */
  key: string;
  /** Byte length of the snapshot (the logical size, after inner plugins). */
  size: number;
  /** When the snapshotted object was last modified (ms epoch), parsed from the id. */
  lastModified: number;
  /** The snapshot's ETag, when the adapter reports one. */
  etag?: string;
}

/**
 * The methods {@link versioning} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type VersioningApi = {
  /**
   * List the saved versions of `key`, **newest first**. Each entry's
   * `versionId` can be passed to {@link VersioningApi.restore}. Returns an empty
   * array when the key has no history.
   */
  versions(key: string): Promise<FileVersion[]>;
  /**
   * Roll `key` back to a prior version — the newest one when `versionId` is
   * omitted (an undo of the last change). The current bytes are snapshotted
   * first, so a restore is itself reversible. Resolves to the restored
   * {@link StoredFile} (via `head`). Throws when the key has no versions, or the
   * given `versionId` doesn't exist.
   */
  restore(key: string, versionId?: string): Promise<StoredFile>;
};

export interface VersioningOptions {
  /**
   * Where snapshots are stored, as a key prefix. Defaults to `".versions"`.
   * Versions of `photos/a.jpg` live at `".versions/photos/a.jpg/<id>"`. Objects
   * under this prefix are hidden from `list()` (unless you list within it) and
   * are never themselves versioned. Don't store your own data under it.
   */
  prefix?: string;
  /**
   * Cap the number of versions kept per key. After each snapshot the oldest
   * versions beyond this many are pruned. Omit to keep every version (history
   * grows unbounded). Must be a positive integer.
   */
  limit?: number;
}

/** Pad ms-epoch times to a fixed width so version ids sort chronologically. */
const TIME_WIDTH = 16;
/** Cap the etag portion of a version id; full content etags are far shorter. */
const ETAG_WIDTH = 32;
const RADIX = 10;

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
      "versioning: prefix must not be empty or all slashes"
    );
  }
  return normalized;
};

/**
 * A time-ordered, content-unique id for a snapshot: the object's last-modified
 * time (zero-padded so a lexical sort is chronological) plus a slug of its
 * ETag, which changes with the content. Falls back to "now" / "x" on the rare
 * adapter that reports neither.
 */
const versionId = (file: StoredFile): string => {
  const time = (file.lastModified ?? Date.now())
    .toString()
    .padStart(TIME_WIDTH, "0");
  const tag =
    (file.etag ?? "").replaceAll(/[^a-zA-Z0-9]/gu, "").slice(0, ETAG_WIDTH) ||
    "x";
  return `${time}-${tag}`;
};

/**
 * The version id of a key listed under its own version directory, or
 * `undefined` when the listed key belongs to a nested key. Version dirs nest —
 * `a`'s dir is a prefix of `a/b`'s — so a listing of `.versions/a/` also
 * returns `.versions/a/b/<id>`. A snapshot of `key` itself is exactly
 * `dir + <id>` with no further slashes; anything deeper belongs to a nested
 * key and must not be counted, restored, or pruned as a version of `key`.
 */
const ownVersionId = (listedKey: string, dir: string): string | undefined => {
  const id = listedKey.slice(dir.length);
  return id.includes("/") ? undefined : id;
};

/** Recover the source object's last-modified time from a {@link versionId}. */
const timeOf = (id: string): number => {
  const dash = id.indexOf("-");
  const digits = dash === -1 ? id : id.slice(0, dash);
  const parsed = Number.parseInt(digits, RADIX);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Snapshot the prior bytes of any object before an overwrite or delete, and add
 * `versions()` / `restore()` so you can roll a key back. Before an `upload`,
 * `delete`, or the destination of a `copy` / `move` clobbers an existing object,
 * the plugin server-side-copies it to a time-stamped key under a version prefix
 * (`.versions/` by default); the live object is untouched.
 *
 * Snapshots are plain object copies, so it's **body-transparent** — unlike
 * `encryption()` / `compression()` it never buffers, transforms, or reads the
 * body, which leaves streaming, range downloads, `url()`, and `signedUploadUrl()`
 * all working normally. It composes with the transforming plugins by copying
 * whatever they stored (a version of an encrypted object stays encrypted and
 * still restores cleanly), so place it **first** (outermost):
 * `plugins: [versioning(), compression(), encryption(key)]`.
 *
 * This is the first plugin to use `extend`, so reach for {@link createFiles} to
 * surface `files.versions()` / `files.restore()` on the type.
 *
 * Trade-offs, by design:
 * - **A `head` + `copy` per overwrite/delete.** Snapshotting costs two extra
 *   adapter round-trips on writes that hit an existing object; first writes
 *   (nothing to snapshot) cost only the `head`.
 * - **Direct presigned writes bypass it.** A client `PUT` to a `signedUploadUrl`
 *   never runs the plugin, so no snapshot is taken; write through the instance
 *   to version. (It's a safety net, not a security control, so it doesn't fail
 *   closed the way `validation()` does.)
 * - **`move` snapshots only its destination.** A rename relocates the bytes
 *   rather than destroying them, so the source isn't snapshotted.
 * - **History is unbounded** unless you set `limit`.
 *
 * @param options optional `{ prefix, limit }` — where snapshots live and how
 *   many to keep per key.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { versioning } from "files-sdk/versioning";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [versioning({ limit: 10 })],
 * });
 *
 * await files.upload("notes.txt", "v1");
 * await files.upload("notes.txt", "v2"); // "v1" snapshotted first
 *
 * const [previous] = await files.versions("notes.txt");
 * await files.restore("notes.txt", previous.versionId); // back to "v1"
 * ```
 */
export const versioning = (
  options: VersioningOptions = {}
): FilesPlugin<VersioningApi> => {
  const versionDir = normalizeDir(options.prefix ?? ".versions");
  const { limit } = options;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new FilesError(
      "Provider",
      `versioning: limit must be a positive integer, received ${limit}`
    );
  }

  const versionsDirFor = (key: string): string => `${versionDir}/${key}/`;
  /** Whether a key lives in the version store — those are never re-versioned. */
  const isVersionKey = (key: string): boolean =>
    key === versionDir || key.startsWith(`${versionDir}/`);

  /** Drop the oldest versions of `key` beyond `max`, after a fresh snapshot. */
  const prune = async (
    key: string,
    next: PluginNext,
    max: number
  ): Promise<void> => {
    const dir = versionsDirFor(key);
    // Paginate to exhaustion (like versions() does) — a single page would
    // under-count once the history exceeds one provider page, leaving the
    // configured limit unenforced.
    const own: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await next({
        kind: "list",
        options: { prefix: dir, ...(cursor !== undefined && { cursor }) },
      });
      for (const file of page.items) {
        if (ownVersionId(file.key, dir) !== undefined) {
          own.push(file.key);
        }
      }
      ({ cursor } = page);
    } while (cursor !== undefined);
    if (own.length <= max) {
      return;
    }
    // Version keys sort chronologically (padded-time prefix), so the front of
    // the sorted list is the oldest.
    const excess = own.toSorted().slice(0, own.length - max);
    for (const versionKey of excess) {
      await next({ key: versionKey, kind: "delete" });
    }
  };

  /**
   * Copy the current bytes of `key` (if any) to a fresh version key. Runs via
   * `next`, so the snapshot ops stay on the inner chain — they never re-enter
   * this plugin, which is what keeps `restore`'s copy from recursing.
   */
  const snapshot = async (key: string, next: PluginNext): Promise<void> => {
    if (isVersionKey(key)) {
      return;
    }
    let current: StoredFile;
    try {
      current = await next({ key, kind: "head" });
    } catch (error) {
      // Nothing there yet — a first write or a restore onto a deleted key.
      if (error instanceof FilesError && error.code === "NotFound") {
        return;
      }
      throw error;
    }
    await next({
      from: key,
      kind: "copy",
      to: `${versionsDirFor(key)}${versionId(current)}`,
    });
    if (limit !== undefined) {
      await prune(key, next, limit);
    }
  };

  /**
   * Hide version objects from listings, so snapshots don't pollute `list()` —
   * unless the caller is explicitly listing within the version prefix (which is
   * how `versions()` reads them). Filtering keeps the page's `cursor`, so
   * pagination still resumes correctly; pages may just come back shorter.
   */
  const hideVersions = (
    result: ListResult,
    listOptions: ListOptions | undefined
  ): ListResult => {
    const requested = listOptions?.prefix;
    if (
      requested !== undefined &&
      (requested === versionDir || requested.startsWith(`${versionDir}/`))
    ) {
      return result;
    }
    const marker = `${versionDir}/`;
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

  const listVersions = async (
    files: Files,
    key: string
  ): Promise<FileVersion[]> => {
    const dir = versionsDirFor(key);
    const out: FileVersion[] = [];
    let cursor: string | undefined;
    do {
      const { cursor: nextCursor, items } = await files.list({
        prefix: dir,
        ...(cursor !== undefined && { cursor }),
      });
      for (const item of items) {
        const id = ownVersionId(item.key, dir);
        if (id === undefined) {
          continue;
        }
        out.push({
          key: item.key,
          lastModified: timeOf(id),
          size: item.size,
          versionId: id,
          ...(item.etag !== undefined && { etag: item.etag }),
        });
      }
      cursor = nextCursor;
    } while (cursor !== undefined);
    // Newest first: version ids sort chronologically, so reverse the order.
    return out.toSorted((a, b) => b.versionId.localeCompare(a.versionId));
  };

  const restore = async (
    files: Files,
    key: string,
    requested?: string
  ): Promise<StoredFile> => {
    let id = requested;
    if (id !== undefined && id.includes("/")) {
      // A slash would address into a nested key's version dir (a version of
      // "a/b" via restore("a", "b/<id>")) — never a version of `key` itself.
      throw new FilesError(
        "Provider",
        `versioning: invalid versionId "${id}" — version ids never contain "/"`
      );
    }
    if (id === undefined) {
      const all = await listVersions(files, key);
      const [newest] = all;
      if (!newest) {
        throw new FilesError(
          "Provider",
          `versioning: no versions to restore for "${key}"`
        );
      }
      id = newest.versionId;
    }
    const versionKey = `${versionsDirFor(key)}${id}`;
    if (!(await files.exists(versionKey))) {
      throw new FilesError(
        "Provider",
        `versioning: no version "${id}" for "${key}"`
      );
    }
    // Go through the public copy so the *current* bytes get snapshotted first
    // (the destination is `key`); the source is a version key, so it isn't.
    await files.copy(versionKey, key);
    return files.head(key);
  };

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    switch (op.kind) {
      case "upload":
      case "delete": {
        await snapshot(op.key, next);
        return next(op);
      }
      case "copy":
      case "move": {
        await snapshot(op.to, next);
        return next(op);
      }
      case "list": {
        return hideVersions(await next(op), op.options);
      }
      default: {
        return next(op);
      }
    }
  }) as NonNullable<FilesPlugin["wrap"]>;

  return {
    extend: (files) => ({
      restore: (key, requested) => restore(files, key, requested),
      versions: (key) => listVersions(files, key),
    }),
    name: "versioning",
    wrap,
  };
};
