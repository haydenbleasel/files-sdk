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
