import { describe, expect, test } from "bun:test";

import { rewrapMcpLoadError } from "../src/cli/program.js";

describe("rewrapMcpLoadError", () => {
  test("ERR_MODULE_NOT_FOUND is rewrapped with a helpful message", () => {
    const original = Object.assign(new Error("Cannot find module"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const result = rewrapMcpLoadError(original);
    expect(result).not.toBe(original);
    expect(result.message).toContain("@modelcontextprotocol/sdk");
    expect((result as Error & { cause?: unknown }).cause).toBe(original);
  });

  test("MODULE_NOT_FOUND (CJS-style) is also rewrapped", () => {
    const original = Object.assign(new Error("Cannot find module"), {
      code: "MODULE_NOT_FOUND",
    });
    const result = rewrapMcpLoadError(original);
    expect(result.message).toContain("@modelcontextprotocol/sdk");
    expect((result as Error & { cause?: unknown }).cause).toBe(original);
  });

  test("unrelated errors pass through unchanged", () => {
    const original = new Error("something else broke");
    expect(rewrapMcpLoadError(original)).toBe(original);
  });

  test("non-Error throws pass through (cast to Error at the call site)", () => {
    const result = rewrapMcpLoadError("nope");
    expect(result as unknown).toBe("nope");
  });
});
