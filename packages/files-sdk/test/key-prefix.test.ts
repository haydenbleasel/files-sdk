import { describe, expect, test } from "bun:test";

import {
  resolvedKeySegments,
  resolvesUnder,
} from "../src/internal/key-prefix.js";

describe("resolvedKeySegments", () => {
  test("case-folds, splits on both separators, and resolves dot segments", () => {
    expect(resolvedKeySegments("A/./b\\C//../d")).toEqual(["a", "b", "d"]);
    expect(resolvedKeySegments("/../x")).toEqual(["x"]);
    expect(resolvedKeySegments("")).toEqual([]);
  });
});

describe("resolvesUnder", () => {
  test.each([
    [".trash", ".trash"],
    [".trash/notes.txt", ".trash"],
    [".TRASH/notes.txt", ".trash"],
    [".trash\\notes.txt", ".trash"],
    ["/.trash/notes.txt", ".trash"],
    ["a/../.trash/notes.txt", ".trash"],
    ["./.trash//notes.txt", ".trash"],
    [".versions/a/b", ".Versions"],
    ["files/.store/x", "files/.store"],
  ])("%s resolves under %s", (key, dir) => {
    expect(resolvesUnder(key, dir)).toBe(true);
  });

  test.each([
    [".trashcan/notes.txt", ".trash"],
    ["notes/.trash/x", ".trash"],
    ["files/x", "files/.store"],
    ["anything", ""],
    ["anything", "/./"],
  ])("%s does not resolve under %s", (key, dir) => {
    expect(resolvesUnder(key, dir)).toBe(false);
  });
});
