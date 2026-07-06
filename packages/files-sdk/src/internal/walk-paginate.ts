// Synthesized cursor pagination over a fully-walked key list. The
// network-filesystem adapters (FTP, SFTP) list a directory tree with no native
// pagination, so they walk the whole tree into a sorted `string[]` and slice it
// here. The scheme matches `src/fs/index.ts`'s `list` and the in-memory fake
// (`test/fake-adapter.ts`) so callers see identical pagination semantics across
// every key-list adapter: cursor is the last key of the previous page, and the
// next page starts at the first key strictly greater than it.

export const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

export interface PaginateOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface PaginatedKeys {
  keys: string[];
  cursor?: string;
}

/**
 * Page a sorted key list. Filters by `prefix`, starts after `cursor`, and
 * returns up to `limit` keys (default 1000) plus a `cursor` when more remain.
 * `sortedKeys` must already be sorted with {@link compareKeys}.
 */
export const paginateKeys = (
  sortedKeys: readonly string[],
  options: PaginateOptions = {}
): PaginatedKeys => {
  const prefix = options.prefix ?? "";
  const limit = options.limit ?? 1000;
  const { cursor } = options;
  const filtered = prefix
    ? sortedKeys.filter((key) => key.startsWith(prefix))
    : sortedKeys;
  const startIdx = cursor ? filtered.findIndex((key) => key > cursor) : 0;
  const start = startIdx === -1 ? filtered.length : startIdx;
  const slice = filtered.slice(start, start + limit);
  const lastKey = slice.at(-1);
  const more = start + slice.length < filtered.length;
  return {
    keys: slice,
    ...(more && lastKey !== undefined && { cursor: lastKey }),
  };
};

export interface PaginateHierarchyOptions {
  prefix?: string;
  delimiter: string;
  cursor?: string;
  limit?: number;
}

export interface PaginatedHierarchy {
  /** Direct keys with no delimiter after the prefix. */
  items: string[];
  /** Collapsed groups, each ending in the delimiter. */
  prefixes: string[];
  cursor?: string;
}

/**
 * Synthesize S3-style common-prefix ("folder") listing from a sorted flat key
 * list, for adapters with no native delimiter support (fs, memory, FTP, SFTP,
 * Google Drive, Cloudinary). Mirrors {@link paginateKeys}' cursor scheme so
 * callers see identical pagination across every key-list adapter.
 *
 * Walks in key order spending one shared `limit` budget per **entry**: a
 * direct key (no delimiter at/after `prefix.length`) is an item; otherwise the
 * key collapses into `prefix + segment + delimiter` and every contiguous key
 * under that group is consumed atomically — a collapsed prefix counts as one
 * entry against the budget (matching S3's CommonPrefix accounting) but is never
 * split across a page.
 *
 * The cursor is always the **last real key consumed**, never a collapsed
 * prefix string: a prefix `P` sorts *before* its own group's keys (`P + rest >
 * P`), so resuming at `first key > P` would re-list the group. The last real
 * key sorts after the whole group and before the next entry, so the existing
 * strictly-greater resume lands correctly.
 *
 * `sortedKeys` must already be sorted with {@link compareKeys}.
 */
export const paginateHierarchy = (
  sortedKeys: readonly string[],
  options: PaginateHierarchyOptions
): PaginatedHierarchy => {
  const prefix = options.prefix ?? "";
  const { delimiter } = options;
  const limit = options.limit ?? 1000;
  const { cursor } = options;
  const filtered = prefix
    ? sortedKeys.filter((key) => key.startsWith(prefix))
    : sortedKeys;
  const startIdx = cursor ? filtered.findIndex((key) => key > cursor) : 0;
  const slice = startIdx === -1 ? [] : filtered.slice(startIdx);

  const items: string[] = [];
  const prefixes: string[] = [];
  let budget = limit;
  let lastConsumedKey: string | undefined;
  // The prefix of the group currently being collapsed; its keys are consumed
  // without spending budget so the whole group counts as one entry.
  let activeGroup: string | undefined;
  let scanned = 0;

  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- group-collapse walk needs both the continue (consume a group member) and the break (budget exhausted)
  for (const key of slice) {
    if (activeGroup !== undefined && key.startsWith(activeGroup)) {
      lastConsumedKey = key;
      scanned += 1;
      continue;
    }
    if (budget === 0) {
      break;
    }
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined resets the active-group marker; null would not match the string | undefined type
    activeGroup = undefined;
    const rest = key.slice(prefix.length);
    const d = rest.indexOf(delimiter);
    if (d === -1) {
      items.push(key);
    } else {
      activeGroup = prefix + rest.slice(0, d + delimiter.length);
      prefixes.push(activeGroup);
    }
    lastConsumedKey = key;
    budget -= 1;
    scanned += 1;
  }

  const more = scanned < slice.length;
  return {
    items,
    prefixes,
    ...(more && lastConsumedKey !== undefined && { cursor: lastConsumedKey }),
  };
};

export interface PageKeyListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface PagedKeyList {
  keys: string[];
  prefixes?: string[];
  cursor?: string;
}

/**
 * Page a sorted key list, picking flat ({@link paginateKeys}) or hierarchical
 * ({@link paginateHierarchy}) pagination based on whether `delimiter` is set.
 * The single entry point every key-list adapter (fs, memory, FTP, SFTP, and
 * the test fake) calls so the flat/folder branch lives in one place.
 */
export const pageKeyList = (
  sortedKeys: readonly string[],
  options: PageKeyListOptions = {}
): PagedKeyList => {
  if (options.delimiter) {
    const page = paginateHierarchy(sortedKeys, {
      delimiter: options.delimiter,
      ...(options.prefix !== undefined && { prefix: options.prefix }),
      ...(options.cursor !== undefined && { cursor: options.cursor }),
      ...(options.limit !== undefined && { limit: options.limit }),
    });
    return {
      keys: page.items,
      ...(page.cursor !== undefined && { cursor: page.cursor }),
      ...(page.prefixes.length && { prefixes: page.prefixes }),
    };
  }
  const page = paginateKeys(sortedKeys, options);
  return {
    keys: page.keys,
    ...(page.cursor !== undefined && { cursor: page.cursor }),
  };
};
