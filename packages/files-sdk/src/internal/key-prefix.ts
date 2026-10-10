// Plugin-private key prefixes (`versioning()`'s `.versions`, `softDelete()`'s
// `.trash`, `dedup()`'s `.dedup`) must stay out of a caller's reach however the
// caller spells the key. A plain `startsWith` check misses spellings that a
// lenient backend resolves to the same place: a case-insensitive filesystem or
// drive (`.TRASH/x`), a Windows host that treats `\` as a separator
// (`.trash\x`), or dot segments and doubled slashes (`a/../.trash//x`).

/**
 * The segments `key` resolves to on the most lenient backend: case-folded, with
 * `\` read as a separator, and empty, `.`, and `..` segments resolved.
 */
export const resolvedKeySegments = (key: string): string[] => {
  const segments: string[] = [];
  for (const segment of key.toLowerCase().split(/[/\\]/u)) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments;
};

/**
 * Whether `key` resolves to `dir` or anywhere beneath it, however it's spelled.
 * Stricter than a string-prefix check on purpose: a false positive only refuses
 * an oddly spelled key, while a miss lets a caller read or write plugin-private
 * storage. An empty `dir` reserves nothing.
 */
export const resolvesUnder = (key: string, dir: string): boolean => {
  const dirSegments = resolvedKeySegments(dir);
  if (dirSegments.length === 0) {
    return false;
  }
  const segments = resolvedKeySegments(key);
  return dirSegments.every((segment, index) => segments[index] === segment);
};
