// The `files.search()` pattern compiler, shared with the gateway so a search
// under an authorize `keyPrefix` scope can match the caller-facing key rather
// than the prefixed storage key. Compiles once, up front, so the per-key cost
// during the walk is a single test/compare and an invalid regex throws before
// any provider call.

import type { SearchMatch } from "../index.js";
import { FilesError } from "./errors.js";
import { globMatcher, globSource } from "./glob.js";
import { isString } from "./is.js";
import { isSafeSearchRegex } from "./search-regex.js";

export const SEARCH_MATCHES: readonly SearchMatch[] = [
  "glob",
  "regex",
  "substring",
  "exact",
];

export const isSearchMatch = (value: string): value is SearchMatch =>
  SEARCH_MATCHES.some((match) => match === value);

/**
 * Bounds on an untrusted search pattern. Globs and regexes both run on a
 * backtracking engine, where each unbounded wildcard/quantifier multiplies the
 * worst-case work per key (`*a*a*a…*b` is polynomial in the key length), so the
 * gateway caps how many a pattern may carry before it compiles one.
 */
export interface SearchPatternLimits {
  /** Longest accepted pattern, in characters. */
  maxLength: number;
  /** Most unbounded wildcards/quantifiers (`*`, `**`, `+`, `{n,}`) allowed. */
  maxWildcards: number;
}

// A `{n,m}` range this wide backtracks like an unbounded quantifier.
const WIDE_RANGE = 16;

interface Quantifier {
  /** Upper bound on repetitions; `Infinity` for `*`, `+`, `{n,}`. */
  max: number;
  /** `true` when the quantifier backtracks like an unbounded one. */
  unbounded: boolean;
  /** Characters the quantifier (incl. a lazy `?`) occupies. */
  length: number;
}

const BRACE_QUANTIFIER = /^\{(?<min>\d+)(?<comma>,(?<max>\d*))?\}/u;

const readQuantifier = (source: string, at: number): Quantifier | undefined => {
  const ch = source[at];
  let quantifier: Quantifier | undefined;
  if (ch === "*" || ch === "+") {
    quantifier = { length: 1, max: Infinity, unbounded: true };
  } else if (ch === "?") {
    quantifier = { length: 1, max: 1, unbounded: false };
  } else if (ch === "{") {
    const groups = BRACE_QUANTIFIER.exec(source.slice(at))?.groups;
    if (groups?.min !== undefined) {
      const min = Number(groups.min);
      let max = min;
      if (groups.comma !== undefined) {
        max = groups.max ? Number(groups.max) : Infinity;
      }
      quantifier = {
        length: groups.min.length + (groups.comma?.length ?? 0) + 2,
        max,
        unbounded: max - min > WIDE_RANGE,
      };
    }
  }
  if (quantifier && source[at + quantifier.length] === "?") {
    quantifier.length += 1;
  }
  return quantifier;
};

// Length of a group's opening syntax after `(`: `?:`, `?=`, `?!`, `?<=`,
// `?<!`, `?<name>`; 0 for a plain capturing group.
const groupPrefixLength = (source: string, at: number): number => {
  if (source[at] !== "?") {
    return 0;
  }
  const next = source[at + 1];
  if (next !== "<") {
    return 2;
  }
  const after = source[at + 2];
  if (after === "=" || after === "!") {
    return 3;
  }
  const close = source.indexOf(">", at);
  return close === -1 ? 2 : close - at + 1;
};

// Index just past the character class opening at `at` (`[` … `]`).
const skipClass = (source: string, at: number): number => {
  let i = at + 1;
  while (i < source.length && source[i] !== "]") {
    i += source[i] === "\\" ? 2 : 1;
  }
  return i + 1;
};

interface GroupTally {
  /** Largest count among the group's finished alternatives. */
  best: number;
  /** Count in the alternative being scanned. */
  current: number;
}

/**
 * Count the unbounded quantifiers in a regex `source` along its most expensive
 * alternative, or `Infinity` when one is nested inside another (`(a+)+`,
 * `(?:.*a){10}` — exponential, or a bounded repeat of an unbounded one). A
 * lexical scan, not a full parser: escapes and character classes are skipped,
 * and anything it can't read as a quantifier is treated as a plain atom.
 */
export const countUnboundedQuantifiers = (source: string): number => {
  const stack: GroupTally[] = [{ best: 0, current: 0 }];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // SAFETY: the stack starts with the top-level tally and a `)` only pops a
    // group it pushed (an unmatched `)` is ignored below), so it is never empty.
    const top = stack.at(-1) as GroupTally;
    if (ch === "(") {
      stack.push({ best: 0, current: 0 });
      i += 1 + groupPrefixLength(source, i + 1);
      continue;
    }
    if (ch === "|") {
      top.best = Math.max(top.best, top.current);
      top.current = 0;
      i += 1;
      continue;
    }
    let atom = 0;
    if (ch === ")" && stack.length > 1) {
      stack.pop();
      atom = Math.max(top.best, top.current);
      i += 1;
    } else if (ch === "[") {
      i = skipClass(source, i);
    } else {
      i += ch === "\\" ? 2 : 1;
    }
    // SAFETY: see above — after a pop the enclosing tally is still present.
    const parent = stack.at(-1) as GroupTally;
    const quantifier = readQuantifier(source, i);
    if (!quantifier) {
      parent.current += atom;
      continue;
    }
    i += quantifier.length;
    if (atom > 0 && (quantifier.unbounded || quantifier.max > 1)) {
      if (quantifier.unbounded) {
        return Infinity;
      }
      parent.current += atom * quantifier.max;
    } else {
      parent.current += atom + (quantifier.unbounded ? 1 : 0);
    }
  }
  // SAFETY: the top-level tally is never popped.
  const root = stack[0] as GroupTally;
  return Math.max(root.best, root.current);
};

/**
 * Why `pattern` exceeds `limits`, or `undefined` when it is within them.
 * Substring/exact patterns are only length-checked (they compile to a plain
 * `includes`/`===`); globs are measured on picomatch's compiled regex so `**`,
 * braces, and extglobs count exactly as they will run.
 */
export const searchPatternProblem = (
  pattern: string | RegExp,
  match: SearchMatch,
  caseInsensitive: boolean,
  limits: SearchPatternLimits
): string | undefined => {
  const text = isString(pattern) ? pattern : pattern.source;
  if (text.length > limits.maxLength) {
    return `search pattern is too long (${text.length} > ${limits.maxLength} characters)`;
  }
  if (isString(pattern) && (match === "substring" || match === "exact")) {
    return undefined;
  }
  const isGlob = isString(pattern) && match === "glob";
  const source = isGlob ? globSource(pattern, caseInsensitive) : text;
  // An unanchored regex is retried at every start offset — an implicit
  // leading `.*?`. picomatch always anchors, so only regexes pay this.
  const implicit = !isGlob && !source.startsWith("^") ? 1 : 0;
  const wildcards = countUnboundedQuantifiers(source) + implicit;
  if (wildcards === Infinity) {
    return "search pattern is too complex (nested repetition)";
  }
  if (wildcards > limits.maxWildcards) {
    return `search pattern is too complex (${wildcards} unbounded wildcards; at most ${limits.maxWildcards})`;
  }
  return undefined;
};

export const buildSearchMatcher = (
  pattern: string | RegExp,
  match: SearchMatch,
  caseInsensitive: boolean
): ((key: string) => boolean) => {
  if (isString(pattern) && (match === "substring" || match === "exact")) {
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    const contains = match === "substring";
    return (key) => {
      const hay = caseInsensitive ? key.toLowerCase() : key;
      return contains ? hay.includes(needle) : hay === needle;
    };
  }
  if (isString(pattern) && match === "glob") {
    return globMatcher(pattern, caseInsensitive);
  }
  // A RegExp instance, or a string compiled as a regex.
  let regexp: RegExp;
  if (pattern instanceof RegExp) {
    regexp = new RegExp(
      pattern.source,
      caseInsensitive && !pattern.flags.includes("i")
        ? `${pattern.flags}i`
        : pattern.flags
    );
  } else {
    try {
      regexp = new RegExp(pattern, caseInsensitive ? "iu" : "u");
    } catch (error) {
      throw new FilesError(
        "Provider",
        `search pattern is not a valid regular expression: ${pattern}`,
        error
      );
    }
  }
  if (!isSafeSearchRegex(regexp)) {
    throw new FilesError("Provider", "search pattern is too complex");
  }
  return (key) => {
    regexp.lastIndex = 0;
    return regexp.test(key);
  };
};
