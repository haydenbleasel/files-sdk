import { describe, expect, test } from "bun:test";

import {
  assertRangeHonored,
  deleteManyWithFallback,
  httpRangeHeader,
  mapMany,
  normalizeBody,
  rangeRequestHeaders,
  rangedResponseSize,
  rangedSize,
} from "../src/internal/core.js";
import { FilesError } from "../src/internal/errors.js";

describe("normalizeBody content types", () => {
  test("an untyped Blob falls back to application/octet-stream", async () => {
    // Blob.type is "" (never nullish) when no type was given, so a `??`
    // fallback would let the empty string through to the provider.
    const normalized = await normalizeBody(new Blob(["hi"]));
    expect(normalized.contentType).toBe("application/octet-stream");
  });

  test("a typed Blob keeps its own type", async () => {
    const normalized = await normalizeBody(
      new Blob(["hi"], { type: "image/png" })
    );
    expect(normalized.contentType).toBe("image/png");
  });

  test("the caller's hint beats the Blob type", async () => {
    const normalized = await normalizeBody(
      new Blob(["hi"], { type: "image/png" }),
      "application/json"
    );
    expect(normalized.contentType).toBe("application/json");
  });
});

describe("range helpers", () => {
  test("httpRangeHeader renders inclusive and open-ended ranges", () => {
    expect(httpRangeHeader({ end: 99, start: 0 })).toBe("bytes=0-99");
    expect(httpRangeHeader({ start: 1024 })).toBe("bytes=1024-");
  });

  test("rangeRequestHeaders builds a Range header for a range", () => {
    expect(rangeRequestHeaders({ end: 4, start: 2 })).toEqual({
      Range: "bytes=2-4",
    });
  });

  test("rangedSize clamps end past EOF and a start at/after EOF", () => {
    expect(rangedSize(10, { end: 4, start: 2 })).toBe(3);
    expect(rangedSize(10, { start: 7 })).toBe(3);
    // end past EOF is clamped to the last byte.
    expect(rangedSize(5, { end: 99, start: 0 })).toBe(5);
    // start at/after EOF yields 0 rather than a negative length.
    expect(rangedSize(5, { start: 5 })).toBe(0);
    expect(rangedSize(5, { start: 9 })).toBe(0);
  });

  test("rangedResponseSize prefers the Content-Length, else computes it", () => {
    expect(rangedResponseSize("3", 10, { end: 4, start: 2 })).toBe(3);
    // No header → fall back to the computed slice length.
    expect(rangedResponseSize(null, 10, { start: 7 })).toBe(3);
  });

  test("assertRangeHonored passes a 206 and throws on a 200", () => {
    expect(() => assertRangeHonored(206, "provider")).not.toThrow();
    expect(() => assertRangeHonored(200, "provider")).toThrow(FilesError);
    expect(() => assertRangeHonored(200, "provider")).toThrow(
      /ignored the requested byte range/u
    );
  });
});

// These exercise the early-return and stopOnError-success branches of the
// shared bulk engines that no adapter happens to hit (empty input, the
// all-succeed sequential path, and the worker-pool's sparse-array guard).

describe("deleteManyWithFallback", () => {
  test("returns empty result without calling remove for an empty list", async () => {
    let calls = 0;
    const result = await deleteManyWithFallback([], () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(result).toEqual({ deleted: [] });
    expect(calls).toBe(0);
  });

  test("stopOnError returns every key when all removes succeed", async () => {
    const removed: string[] = [];
    const result = await deleteManyWithFallback(
      ["a", "b", "c"],
      (key) => {
        removed.push(key);
        return Promise.resolve();
      },
      { stopOnError: true }
    );
    expect(result).toEqual({ deleted: ["a", "b", "c"] });
    expect(removed).toEqual(["a", "b", "c"]);
  });

  test("worker pool skips undefined slots (sparse key array)", async () => {
    // Leave a hole at index 1 so the worker pool reads `keys[1] === undefined`.
    const keys: string[] = ["a"];
    keys[2] = "c";
    const removed: string[] = [];
    const result = await deleteManyWithFallback(keys, (key) => {
      removed.push(key);
      return Promise.resolve();
    });
    expect(result.deleted).toEqual(["a", "c"]);
    expect(result.errors).toBeUndefined();
    expect(removed).toEqual(["a", "c"]);
  });
});

describe("mapMany", () => {
  test("stopOnError returns all results when every item succeeds", async () => {
    const result = await mapMany(
      ["a", "b"],
      (item) => item,
      (item) => Promise.resolve(item.toUpperCase()),
      { stopOnError: true }
    );
    expect(result).toEqual({ errors: [], results: ["A", "B"] });
  });
});
