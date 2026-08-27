import { describe, expect, test } from "bun:test";

import { globMatcher, globPrefix } from "../src/internal/glob.js";

describe("globMatcher", () => {
  test("`*` matches within a segment but not across `/`", () => {
    const m = globMatcher("a*", false);
    expect(m("ab")).toBe(true);
    expect(m("a")).toBe(true);
    expect(m("a/b")).toBe(false);
  });

  test("`**` spans path segments", () => {
    const m = globMatcher("uploads/**", false);
    expect(m("uploads/a/b.txt")).toBe(true);
    expect(m("uploads/x")).toBe(true);
    expect(m("other/x")).toBe(false);
  });

  test("`**/*` matches at any depth, including zero directories", () => {
    const m = globMatcher("docs/**/*.pdf", false);
    expect(m("docs/x.pdf")).toBe(true);
    expect(m("docs/2024/q1.pdf")).toBe(true);
    expect(m("docs/a/b/c.pdf")).toBe(true);
    expect(m("img/x.pdf")).toBe(false);
  });

  test("`?` matches a single character", () => {
    const m = globMatcher("a?c", false);
    expect(m("abc")).toBe(true);
    expect(m("ac")).toBe(false);
  });

  test("dotfiles match (keys are opaque, not hidden files)", () => {
    const m = globMatcher("*.pdf", false);
    expect(m(".secret.pdf")).toBe(true);
    expect(globMatcher("uploads/*", false)("uploads/.hidden")).toBe(true);
  });

  test("caseInsensitive maps to nocase", () => {
    expect(globMatcher("*.PNG", true)("photo.png")).toBe(true);
    expect(globMatcher("*.PNG", false)("photo.png")).toBe(false);
  });

  test("a wildcard-free pattern is an exact key match, not a substring", () => {
    const m = globMatcher("report.pdf", false);
    expect(m("report.pdf")).toBe(true);
    expect(m("q1-report.pdf")).toBe(false);
    expect(m("report.pdf.bak")).toBe(false);
  });

  test("brace and class patterns are supported (standard glob)", () => {
    expect(globMatcher("img/{a,b}.png", false)("img/a.png")).toBe(true);
    expect(globMatcher("img/{a,b}.png", false)("img/c.png")).toBe(false);
    expect(globMatcher("v[0-9].txt", false)("v3.txt")).toBe(true);
    expect(globMatcher("v[0-9].txt", false)("vx.txt")).toBe(false);
  });
});

describe("globPrefix", () => {
  test("returns the literal base before the first wildcard", () => {
    expect(globPrefix("uploads/2024/*.pdf")).toBe("uploads/2024");
  });

  test("returns the nearest literal segment for a partial filename", () => {
    expect(globPrefix("logs/app*.log")).toBe("logs");
  });

  test("globstar base", () => {
    expect(globPrefix("invoices/**")).toBe("invoices");
    expect(globPrefix("invoices/**/*.pdf")).toBe("invoices");
  });

  test("is empty when the pattern opens with a wildcard", () => {
    expect(globPrefix("*.pdf")).toBe("");
    expect(globPrefix("**/*.pdf")).toBe("");
  });

  test("returns the whole pattern when it has no wildcard", () => {
    expect(globPrefix("a/b/c")).toBe("a/b/c");
  });

  test("is empty for a negated pattern (matches by exclusion)", () => {
    expect(globPrefix("!keep.txt")).toBe("");
  });

  test("unescapes backslash escapes so the prefix matches real keys", () => {
    expect(globPrefix("a\\*b/x")).toBe("a*b/x");
    expect(globPrefix("a\\*b/*.txt")).toBe("a*b");
    // An escaped backslash stands for one literal backslash.
    expect(globPrefix("a\\\\b/x")).toBe("a\\b/x");
    expect(globMatcher("a\\*b/x", false)("a*b/x")).toBe(true);
  });
});
