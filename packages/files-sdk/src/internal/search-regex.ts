import safeRegex from "safe-regex2";

const SEARCH_REGEX_REPETITION_LIMIT = 25;

export const isSafeSearchRegex = (pattern: string | RegExp): boolean =>
  safeRegex(pattern, { limit: SEARCH_REGEX_REPETITION_LIMIT });
