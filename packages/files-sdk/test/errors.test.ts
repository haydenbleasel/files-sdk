import { describe, expect, test } from "bun:test";

import { FilesError } from "../src/internal/errors.js";
import { ValidationError } from "../src/validation/index.js";

describe("FilesError", () => {
  test("constructor sets name, code, message, and cause", () => {
    const cause = new Error("inner");
    const err = new FilesError("NotFound", "missing", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("FilesError");
    expect(err.code).toBe("NotFound");
    expect(err.message).toBe("missing");
    expect(err.cause).toBe(cause);
  });

  test("wrap returns the same instance for FilesError", () => {
    const err = new FilesError("Conflict", "boom");
    expect(FilesError.wrap(err)).toBe(err);
  });

  test("wrap preserves Error message and defaults to Provider", () => {
    const inner = new Error("oops");
    const wrapped = FilesError.wrap(inner);
    expect(wrapped).toBeInstanceOf(FilesError);
    expect(wrapped.code).toBe("Provider");
    expect(wrapped.message).toBe("oops");
    expect(wrapped.cause).toBe(inner);
  });

  test("wrap stringifies non-Error values", () => {
    const wrapped = FilesError.wrap("kaboom");
    expect(wrapped.message).toBe("kaboom");
    expect(wrapped.cause).toBe("kaboom");
  });

  test("subclasses keep prototype-based instanceof", () => {
    expect(new ValidationError("size", "too big")).toBeInstanceOf(FilesError);
    expect(new FilesError("Provider", "x")).not.toBeInstanceOf(ValidationError);
  });

  test("wrap honors fallbackCode", () => {
    const wrapped = FilesError.wrap(new Error("x"), "Unauthorized");
    expect(wrapped.code).toBe("Unauthorized");
  });
});
