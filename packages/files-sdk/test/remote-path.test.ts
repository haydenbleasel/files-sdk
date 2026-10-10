import { describe, expect, test } from "bun:test";

import { FilesError } from "../src/internal/errors.js";
import {
  assertNotStagingPath,
  isStagingPath,
  joinRemotePath,
  trimSlashes,
} from "../src/internal/remote-path.js";

const NULL_BYTE = String.fromCodePoint(0);

describe("trimSlashes", () => {
  test("strips trailing slashes", () => {
    expect(trimSlashes("uploads/")).toBe("uploads");
    expect(trimSlashes("uploads///")).toBe("uploads");
  });

  test("strips leading and trailing slashes together", () => {
    expect(trimSlashes("/uploads/")).toBe("uploads");
    expect(trimSlashes("/")).toBe("");
  });

  test("leaves a clean string untouched", () => {
    expect(trimSlashes("uploads")).toBe("uploads");
  });
});

describe("joinRemotePath", () => {
  test("preserves an absolute root with a trailing slash", () => {
    expect(joinRemotePath("/uploads/", "a/b.txt")).toBe("/uploads/a/b.txt");
  });

  test.each([["/"], ["."], ["./"], ["//./"]])(
    "rejects a key that resolves to the root itself: %j",
    (key) => {
      // On WebDAV, a DELETE of the resulting root collection would recurse
      // through everything under it.
      for (const root of ["/", "/uploads", "", "."]) {
        expect(() => joinRemotePath(root, key)).toThrow(
          /must name an object below the adapter root/u
        );
      }
    }
  );

  test("validation failures are permanent, so they are never retried", () => {
    for (const key of ["../etc/passwd", `a${NULL_BYTE}b`, "."]) {
      try {
        joinRemotePath("/uploads", key);
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Invalid");
        expect((error as FilesError).permanent).toBe(true);
      }
    }
    try {
      assertNotStagingPath("ftp", "up/x.fls-part", "x");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as FilesError).permanent).toBe(true);
    }
  });

  test.each([
    ["..\\..\\x"],
    ["a\\b.txt"],
    ["dir/..\\secret"],
    ["\\\\host\\share"],
  ])("rejects a key containing a backslash: %j", (key) => {
    // A server on a Windows host splits on `\` too, so `..\..\x` would
    // climb out of the root as a single `/`-segment.
    for (const root of ["/uploads", ""]) {
      expect(() => joinRemotePath(root, key)).toThrow(
        expect.objectContaining({
          code: "Invalid",
          message: expect.stringMatching(/backslash/u),
        })
      );
    }
  });

  test.each([["C:/Windows/win.ini"], ["c:"], ["/D:/x"], ["./z:/x"], ["C:foo"]])(
    "rejects a key whose first segment is a drive letter: %j",
    (key) => {
      // With an empty root, `C:/Windows/win.ini` is an absolute path on a
      // Windows server, and `C:foo` is relative to the drive's current dir.
      for (const root of ["", ".", "/", "/uploads"]) {
        expect(() => joinRemotePath(root, key)).toThrow(
          expect.objectContaining({
            code: "Invalid",
            message: expect.stringMatching(/drive letter/u),
          })
        );
      }
    }
  );

  test("still accepts colons that aren't a leading drive letter", () => {
    expect(joinRemotePath("", "logs/C:/x.txt")).toBe("logs/C:/x.txt");
    expect(joinRemotePath("/up", "2024-01-01T10:00:00.log")).toBe(
      "/up/2024-01-01T10:00:00.log"
    );
    expect(joinRemotePath("/up", "ab:c/d")).toBe("/up/ab:c/d");
  });

  test("rejects a key containing a null byte", () => {
    const key = `a${NULL_BYTE}b`;
    expect(() => joinRemotePath("/uploads", key)).toThrow(FilesError);
    try {
      joinRemotePath("/uploads", key);
    } catch (error) {
      expect((error as FilesError).code).toBe("Invalid");
      expect((error as FilesError).message).toMatch(/null byte/u);
    }
  });
});

describe("resumable staging paths", () => {
  test("isStagingPath matches the suffix case-insensitively", () => {
    expect(isStagingPath("a/b.bin.fls-part")).toBe(true);
    expect(isStagingPath("a/b.bin.FLS-PART")).toBe(true);
    expect(isStagingPath("a/b.bin")).toBe(false);
    expect(isStagingPath("a/b.fls-part.bin")).toBe(false);
  });

  test("assertNotStagingPath throws Invalid on a staging path only", () => {
    expect(() => assertNotStagingPath("ftp", "up/x.fls-part", "x")).toThrow(
      /ftp: keys ending in \.fls-part are reserved/u
    );
    expect(() => assertNotStagingPath("ftp", "up/x.fls-part", "x")).toThrow(
      expect.objectContaining({ code: "Invalid" })
    );
    expect(() => assertNotStagingPath("sftp", "up/x.bin", "x")).not.toThrow();
  });
});
