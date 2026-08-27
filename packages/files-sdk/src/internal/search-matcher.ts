// The `files.search()` pattern compiler, shared with the gateway so a search
// under an authorize `keyPrefix` scope can match the caller-facing key rather
// than the prefixed storage key. Compiles once, up front, so the per-key cost
// during the walk is a single test/compare and an invalid regex throws before
// any provider call.

import type { SearchMatch } from "../index.js";
import { FilesError } from "./errors.js";
import { globMatcher } from "./glob.js";
import { isSafeSearchRegex } from "./search-regex.js";

export const SEARCH_MATCHES: readonly SearchMatch[] = [
  "glob",
  "regex",
  "substring",
  "exact",
];

export const isSearchMatch = (value: string): value is SearchMatch =>
  (SEARCH_MATCHES as readonly string[]).includes(value);

export const buildSearchMatcher = (
  pattern: string | RegExp,
  match: SearchMatch,
  caseInsensitive: boolean
): ((key: string) => boolean) => {
  if (
    typeof pattern === "string" &&
    (match === "substring" || match === "exact")
  ) {
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    const contains = match === "substring";
    return (key) => {
      const hay = caseInsensitive ? key.toLowerCase() : key;
      return contains ? hay.includes(needle) : hay === needle;
    };
  }
  if (typeof pattern === "string" && match === "glob") {
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
