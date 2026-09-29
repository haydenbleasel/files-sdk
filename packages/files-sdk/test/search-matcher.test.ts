import { describe, expect, test } from "bun:test";

import { globSource } from "../src/internal/glob.js";
import {
  countUnboundedQuantifiers,
  isSearchMatch,
  searchPatternProblem,
} from "../src/internal/search-matcher.js";

const LIMITS = { maxLength: 256, maxWildcards: 4 };

describe("countUnboundedQuantifiers", () => {
  test("counts *, +, {n,} and wide {n,m} ranges", () => {
    expect(countUnboundedQuantifiers("a*b+c{2,}")).toBe(3);
    expect(countUnboundedQuantifiers("a{1,100}")).toBe(1);
    // Narrow ranges, `?`, and fixed counts don't backtrack like `*`.
    expect(countUnboundedQuantifiers("a{1,2}b?c{4}")).toBe(0);
    // Lazy quantifiers count the same as greedy ones.
    expect(countUnboundedQuantifiers("a*?b+?")).toBe(2);
  });

  test("skips escapes and character classes", () => {
    expect(countUnboundedQuantifiers("\\*\\+[*+]")).toBe(0);
    expect(countUnboundedQuantifiers("[\\]*]x")).toBe(0);
    expect(countUnboundedQuantifiers("[a-z]*")).toBe(1);
  });

  test("takes the costliest alternative, not the sum", () => {
    expect(countUnboundedQuantifiers("(?:a*|b*c*|d)")).toBe(2);
    expect(countUnboundedQuantifiers("a*|b*|c*")).toBe(1);
  });

  test("reads every group opener", () => {
    expect(
      countUnboundedQuantifiers("(?<name>a*)(?<=b+)(?<!c*)(?=d*)(?!e*)")
    ).toBe(5);
    // An unterminated named group falls back to a plain two-char opener.
    expect(countUnboundedQuantifiers("(?<abc")).toBe(0);
  });

  test("multiplies a bounded repeat of a group with wildcards", () => {
    expect(countUnboundedQuantifiers("(.*a){3}")).toBe(3);
    expect(countUnboundedQuantifiers("(.*a)?")).toBe(1);
    expect(countUnboundedQuantifiers("(ab)+")).toBe(1);
  });

  test("nested repetition is infinitely expensive", () => {
    expect(countUnboundedQuantifiers("(a+)+")).toBe(Infinity);
    expect(countUnboundedQuantifiers("(?:a*b){2,}")).toBe(Infinity);
  });

  test("tolerates an unmatched close paren", () => {
    expect(countUnboundedQuantifiers("a*)b*")).toBe(2);
  });
});

describe("searchPatternProblem", () => {
  test("accepts everyday globs and regexes", () => {
    for (const glob of [
      "*.png",
      "uploads/**/*.pdf",
      "img/{a,b}.png",
      "**/*.{png,jpg,gif,webp}",
      "report.pdf",
    ]) {
      expect(searchPatternProblem(glob, "glob", false, LIMITS)).toBeUndefined();
    }
    expect(
      searchPatternProblem(/^users\/\d+\/.*\.png$/u, "glob", false, LIMITS)
    ).toBeUndefined();
    expect(
      searchPatternProblem("\\.png$", "regex", false, LIMITS)
    ).toBeUndefined();
  });

  test("rejects wildcard-heavy globs, flat regex chains and nesting", () => {
    expect(
      searchPatternProblem(`${"*a".repeat(10)}*b`, "glob", true, LIMITS)
    ).toContain("11 unbounded wildcards");
    expect(
      searchPatternProblem(".*a.*a.*a.*b", "regex", false, LIMITS)
    ).toContain("too complex");
    expect(searchPatternProblem("*(a*)", "glob", false, LIMITS)).toContain(
      "nested repetition"
    );
  });

  test("an unanchored regex pays one implicit wildcard", () => {
    const tight = { maxLength: 256, maxWildcards: 1 };
    expect(searchPatternProblem("^a.*", "regex", false, tight)).toBeUndefined();
    expect(searchPatternProblem("a.*", "regex", false, tight)).toContain(
      "2 unbounded wildcards"
    );
  });

  test("substring/exact are only length-checked", () => {
    expect(
      searchPatternProblem("*".repeat(50), "substring", false, LIMITS)
    ).toBeUndefined();
    expect(
      searchPatternProblem("x".repeat(300), "exact", false, LIMITS)
    ).toContain("too long");
  });
});

test("isSearchMatch narrows the match modes", () => {
  expect(isSearchMatch("regex")).toBe(true);
  expect(isSearchMatch("fuzzy")).toBe(false);
});

describe("globSource", () => {
  test("is the anchored regex picomatch runs", () => {
    const source = globSource("*.png", false);
    expect(source.startsWith("^")).toBe(true);
    expect(new RegExp(source, "u").test("a.png")).toBe(true);
  });
});
