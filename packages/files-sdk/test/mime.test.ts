import { describe, expect, test } from "bun:test";

import { inferTypeFromName } from "../src/internal/mime.js";

describe("inferTypeFromName", () => {
  test.each([
    ["report.pdf", "application/pdf"],
    ["photo.JPG", "image/jpeg"],
    ["archive.zip", "application/zip"],
    ["data.json", "application/json"],
    ["feed.xml", "application/xml"],
    ["icon.svg", "image/svg+xml"],
    // The `mime` table reaches well past the old hand-rolled 19 entries.
    [
      "letter.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["photo.avif", "image/avif"],
    ["font.woff2", "font/woff2"],
  ])("%s → %s", (name, type) => {
    expect(inferTypeFromName(name)).toBe(type);
  });

  test.each([
    ["notes.txt", "text/plain; charset=utf-8"],
    ["page.html", "text/html; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["module.mjs", "text/javascript; charset=utf-8"],
    ["README.md", "text/markdown; charset=utf-8"],
  ])("text types carry an explicit UTF-8 charset: %s", (name, type) => {
    expect(inferTypeFromName(name)).toBe(type);
  });

  test.each([["Makefile"], [".env"], ["blob.unknownext"], [""]])(
    "unknowns fall back to octet-stream: %j",
    (name) => {
      expect(inferTypeFromName(name)).toBe("application/octet-stream");
    }
  );
});
