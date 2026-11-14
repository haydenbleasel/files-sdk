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
 * The regex source picomatch compiles `glob` to (same options as
 * {@link globMatcher}) — what actually runs per key, so a complexity check can
 * count its quantifiers rather than re-deriving glob semantics.
 */
export const globSource = (glob: string, caseInsensitive: boolean): string =>
  picomatch.makeRe(glob, { dot: true, nocase: caseInsensitive }).source;

// An escape pair, or the first character of glob syntax: a wildcard, the
// opener of a class / brace / group, or the `+` `@` `!` of an extglob.
const ESCAPE_OR_SYNTAX = /\\.|(?<syntax>[*?[{(]|[+@!](?=\())/gsu;

/**
 * `base` up to its first unescaped glob syntax. picomatch's scan stops looking
 * for wildcards once it meets an escaped brace (`dir\{1\}/*.pdf`), a brace it
 * matches literally (`users/{id}/*.json`), or an unclosed bracket, and returns
 * the whole pattern as the base. Listing that as a literal prefix finds no
 * keys, so only the part before the syntax is kept.
 */
const literalHead = (base: string): string => {
  for (const match of base.matchAll(ESCAPE_OR_SYNTAX)) {
    if (match.groups?.syntax !== undefined) {
      return base.slice(0, match.index);
    }
  }
  return base;
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
 * - `users/{id}/*.json` → `users/` (see {@link literalHead})
 */
export const globPrefix = (glob: string): string => {
  const { base, negated } = picomatch.scan(glob);
  // The scanned base keeps the pattern's backslash escapes (`a\*b` for a
  // literal `a*b`); the keys it's matched against don't, so unescape before
  // handing it to the provider as a literal prefix.
  return negated
    ? ""
    : literalHead(base).replaceAll(/\\(?<literal>.)/gu, "$<literal>");
};
