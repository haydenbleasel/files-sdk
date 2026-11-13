import { describe, expect, test } from "bun:test";

import {
  isSingleMediaType,
  mediaTypeEssence,
} from "../src/internal/media-type.js";

describe("mediaTypeEssence", () => {
  test.each([
    ["image/png", "image/png"],
    ["Image/PNG", "image/png"],
    [" text/plain ; charset=utf-8", "text/plain"],
    ["application/vnd.api+json", "application/vnd.api+json"],
    ["text/plain;\tcharset=utf-8", "text/plain"],
  ])("%s → %s", (value, essence) => {
    expect(mediaTypeEssence(value)).toBe(essence);
  });

  test.each([
    ["image/png, text/html"],
    ["image/png;a=b, text/html"],
    ["image/png;x=1,image/svg+xml"],
    ["text/html\r\nx-injected: 1"],
    ["text/html\u007F"],
    ["image"],
    ["/png"],
    ["image/"],
    ["image/p ng"],
    ["image/png/x"],
    [""],
  ])("refuses %p", (value) => {
    expect(mediaTypeEssence(value)).toBeUndefined();
  });
});

describe("isSingleMediaType", () => {
  test.each([["application/pdf"], ["text/plain; charset=utf-8"]])(
    "accepts %p",
    (value) => {
      expect(isSingleMediaType(value)).toBe(true);
    }
  );

  test.each([
    ["image/png, text/html"],
    ["text/plain; charset=\u2603"],
    ["text/plain; charset=caf\u00E9"],
    [123],
    [null],
    [undefined],
  ])("refuses %p", (value) => {
    expect(isSingleMediaType(value)).toBe(false);
  });
});
