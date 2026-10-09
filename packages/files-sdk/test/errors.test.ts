import { describe, expect, test } from "bun:test";

import {
  FilesError,
  dispositionUnsupported,
  isDispositionUnsupported,
} from "../src/internal/errors.js";
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

  test("instanceof matches another bundled copy by its brand", () => {
    // Stands in for the `FilesError` another entry's bundle defines (#164).
    const foreign = Object.create(Error.prototype, {
      [Symbol.for("files-sdk.FilesError")]: { value: true },
    });
    expect(foreign instanceof FilesError).toBe(true);
    const others: unknown[] = [new Error("x"), null, "FilesError"];
    for (const value of others) {
      expect(value instanceof FilesError).toBe(false);
    }
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

describe("dispositionUnsupported", () => {
  test("builds a permanent Provider FilesError the predicate recognizes", () => {
    const error = dispositionUnsupported("x: not supported");
    expect(error).toBeInstanceOf(FilesError);
    expect(error.code).toBe("Provider");
    expect(error.message).toBe("x: not supported");
    expect(error.permanent).toBe(true);
    expect(isDispositionUnsupported(error)).toBe(true);
    // The brand stays off the wire.
    expect(Object.keys(error)).not.toContain(
      String(Symbol.for("files-sdk.DispositionUnsupported"))
    );
    expect(JSON.stringify(error)).not.toContain("Disposition");
  });

  test("the predicate matches another bundled copy by its brand", () => {
    // Stands in for the refusal an adapter bundled in another pass throws.
    const foreign = Object.create(Error.prototype, {
      [Symbol.for("files-sdk.DispositionUnsupported")]: { value: true },
      [Symbol.for("files-sdk.FilesError")]: { value: true },
    });
    expect(isDispositionUnsupported(foreign)).toBe(true);
    const others: unknown[] = [
      new FilesError("Provider", "x: `responseContentDisposition` is not"),
      new Error("x"),
      null,
      Object.create(Error.prototype, {
        [Symbol.for("files-sdk.DispositionUnsupported")]: { value: true },
      }),
    ];
    for (const value of others) {
      expect(isDispositionUnsupported(value)).toBe(false);
    }
  });
});
