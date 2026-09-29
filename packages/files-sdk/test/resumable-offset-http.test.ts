import { describe, expect, test } from "bun:test";

import { Files, UploadControl } from "../src/index.js";
import type { Adapter, OffsetResumableDriver } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { createOffsetHttpDriver } from "../src/internal/resumable-offset-http.js";
import { fakeAdapter } from "./fake-adapter.js";

const SESSION = "https://upload.example.com/session/x";

/** A driver adopted onto {@link SESSION}, with `fetch` answering `status`. */
const withStatus = async (
  status: number,
  run: (driver: OffsetResumableDriver) => Promise<void>
): Promise<number> => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch;
  try {
    const driver = createOffsetHttpDriver({
      open: () =>
        Promise.resolve({
          session: { bucket: "b", key: "k", provider: "gcs", uri: SESSION },
          uri: SESSION,
        }),
      parseResult: () => Promise.reject(new Error("unused")),
      partSize: 4,
      resume: () => SESSION,
      wrapErr: (error) => FilesError.wrap(error),
    });
    driver.adopt({ bucket: "b", key: "k", provider: "gcs", uri: SESSION });
    await run(driver);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
};

const chunk = { data: new Uint8Array(4), offset: 0, total: 8 };

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

  test("a mid-chunk 308 without a Range header throws instead of skipping the chunk", async () => {
    // The protocol's 308-without-Range means "nothing persisted" (probe maps
    // it to offset 0); advancing past the chunk would silently drop its bytes.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 308 })
      )) as unknown as typeof fetch;
    try {
      const driver = createOffsetHttpDriver({
        open: () => Promise.reject(new Error("unused")),
        parseResult: () => Promise.reject(new Error("unused")),
        partSize: 4,
        resume: () => "https://upload.example.com/session/x",
        wrapErr: (error) => FilesError.wrap(error),
      });
      driver.adopt({
        bucket: "b",
        key: "k",
        provider: "gcs",
        uri: "https://upload.example.com/session/x",
      });
      await expect(
        driver.uploadAt({
          data: new Uint8Array(4),
          isLast: false,
          offset: 0,
          total: 8,
        })
      ).rejects.toThrow(/no bytes persisted/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("probing an already-finalized session reports a past-the-end offset", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ size: "8" }))) as unknown as typeof fetch;
    try {
      const driver = createOffsetHttpDriver({
        open: () => Promise.reject(new Error("unused")),
        parseResult: () =>
          Promise.resolve({
            contentType: "application/octet-stream",
            key: "k",
            size: 8,
          }),
        partSize: 4,
        resume: () => "https://upload.example.com/session/x",
        wrapErr: (error) => FilesError.wrap(error),
      });
      driver.adopt({
        bucket: "b",
        key: "k",
        provider: "gcs",
        uri: "https://upload.example.com/session/x",
      });
      const { nextOffset } = await driver.probe();
      expect(nextOffset).toBeGreaterThan(8);
      // complete() then serves the probed final result.
      await expect(driver.complete([])).resolves.toMatchObject({ size: 8 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    [404, "NotFound", true],
    [410, "NotFound", true],
    [401, "Unauthorized", true],
    [403, "Unauthorized", true],
    [409, "Conflict", true],
    [412, "Conflict", true],
    [500, "Provider", false],
    [429, "Provider", false],
  ])(
    "HTTP %d maps to %s on every session call",
    async (status, code, permanent) => {
      const expected = { code, permanent };
      await withStatus(status, async (driver) => {
        await expect(driver.probe()).rejects.toMatchObject({
          ...expected,
          message: `resume status check failed (HTTP ${status}).`,
        });
        await expect(
          driver.uploadAt({ ...chunk, isLast: false })
        ).rejects.toMatchObject({
          ...expected,
          message: `chunk upload failed (HTTP ${status}).`,
        });
        await expect(
          driver.uploadAt({ ...chunk, isLast: true })
        ).rejects.toMatchObject({
          ...expected,
          message: `upload failed (HTTP ${status}).`,
        });
      });
    }
  );

  test("an expired session is not retried chunk by chunk", async () => {
    const calls = await withStatus(410, async (driver) => {
      const adapter: Adapter = {
        ...fakeAdapter(),
        resumableUpload: () => driver,
      };
      const files = new Files({ adapter, retries: 3 });
      await expect(
        files.upload("k", new Uint8Array(8), {
          control: new UploadControl(),
          multipart: { partSize: 4 },
        })
      ).rejects.toMatchObject({ code: "NotFound" });
    });
    // One chunk PUT, not retried against the dead session.
    expect(calls).toBe(1);
  });

  test("a transient 503 on a chunk is still retried", async () => {
    const calls = await withStatus(503, async (driver) => {
      const adapter: Adapter = {
        ...fakeAdapter(),
        resumableUpload: () => driver,
      };
      const files = new Files({
        adapter,
        retries: { backoff: () => 0, max: 2 },
      });
      await expect(
        files.upload("k", new Uint8Array(8), {
          control: new UploadControl(),
          multipart: { partSize: 4 },
        })
      ).rejects.toMatchObject({ code: "Provider" });
    });
    expect(calls).toBe(3);
  });
});
