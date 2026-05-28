import { describe, expect, test } from "bun:test";

import { FilesError } from "../src/internal/errors.js";
import { createOffsetHttpDriver } from "../src/internal/resumable-offset-http.js";

// The offset-HTTP driver's per-provider behavior is exercised through the GCS,
// Firebase, and Google Drive adapter suites. This covers the one path those
// can't reach via the orchestrator: discarding before a session was opened.
describe("offset-http driver", () => {
  test("discard before a session is opened is a no-op", async () => {
    const driver = createOffsetHttpDriver({
      open: () => Promise.reject(new Error("unused")),
      parseResult: () => Promise.reject(new Error("unused")),
      partSize: 4,
      resume: () => "uri",
      wrapErr: (error) => FilesError.wrap(error),
    });
    await expect(driver.discard()).resolves.toBeUndefined();
  });
});
