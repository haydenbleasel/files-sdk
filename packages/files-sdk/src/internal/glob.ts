// Glob matching for `files.search()`, backed by picomatch (standard glob
// semantics: `*`, `**` globstar, `?`, `[a-z]`, `{a,b}`, extglobs, `!` negation).
//
// Object keys are opaque, always `/`-separated strings — not host paths — so we
// run picomatch with `dot: true`: a leading dot in a key (`.config`, dedup blob
// prefixes) is just a character, not a hidden file to skip. `caseInsensitive`
// maps to picomatch's `nocase`.

import picomatch from "picomatch";

/** A predicate testing a key against `glob` using standard glob semantics. */
export const globMatcher = (
  glob: string,
  caseInsensitive: boolean
): ((key: string) => boolean) => {
  const isMatch = picomatch(glob, { dot: true, nocase: caseInsensitive });
  return (key) => isMatch(key);
};

/**
 * The literal key prefix every match must start with — picomatch's scanned
 * `base` — used to push a `prefix` down to `listAll` so a search doesn't walk
 * the whole bucket. Empty for a negated pattern (matches by exclusion, so no
 * usable prefix) or one that opens with a wildcard.
 *
 * - `uploads/2024/*.pdf` → `uploads/2024`
 * - `logs/app*.log` → `logs`
 * - `invoices/**` → `invoices`
 * - `*.pdf`, `!keep.txt` → `""`
 * - `a/b/c` → `a/b/c` (no wildcard: the whole key is literal)
 * - `a\*b/x` → `a*b/x` (an escape stands for the literal it guards)
 */
export const globPrefix = (glob: string): string => {
  const { base, negated } = picomatch.scan(glob);
  // The scanned base keeps the pattern's backslash escapes (`a\*b` for a
  // literal `a*b`); the keys it's matched against don't, so unescape before
  // handing it to the provider as a literal prefix.
  return negated ? "" : base.replaceAll(/\\(?<literal>.)/gu, "$<literal>");
};
