import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { Files, UploadControl } from "../src/index.js";
import type {
  Adapter,
  Body,
  OffsetResumableDriver,
  PartMeta,
  PartsResumableDriver,
  ResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// In-memory fake adapters that exercise the orchestrator without a network.
// One drives the parts-mode path (S3/Azure-style), one the offset-mode path
// (GCS/OneDrive/Dropbox-style). Each records call counts so tests can assert
// that a resume only re-uploads what's missing.
// ---------------------------------------------------------------------------

interface DriverStats {
  uploadCalls: number;
  discarded: boolean;
}

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

// key -> remaining failures to inject
type FailPlan = Map<string, number>;

interface FakeServer {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  partSessions: Map<string, Map<number, Uint8Array>>;
  offsetSessions: Map<string, { chunks: Uint8Array[]; received: number }>;
  drivers: DriverStats[];
  fail: FailPlan;
  uploadIds: number;
}

const newServer = (): FakeServer => ({
  drivers: [],
  fail: new Map(),
  objects: new Map(),
  offsetSessions: new Map(),
  partSessions: new Map(),
  uploadIds: 0,
});

const maybeFail = (server: FakeServer, tag: string): void => {
  const remaining = server.fail.get(tag) ?? 0;
  if (remaining > 0) {
    server.fail.set(tag, remaining - 1);
    // A retryable provider error per the SDK's retry policy.
    throw new Error("transient fake failure");
  }
};

const createPartsDriver = (
  server: FakeServer,
  key: string,
  opts: ResumableDriverOptions
): PartsResumableDriver => {
  const stats: DriverStats = { discarded: false, uploadCalls: 0 };
  server.drivers.push(stats);
  const partSize =
    typeof opts.multipart === "object" && opts.multipart.partSize
      ? opts.multipart.partSize
      : 4;
  let uploadId: string | undefined;
  let contentType = "application/octet-stream";
  return {
    adopt(session) {
      if (session.provider !== "s3") {
        throw new Error("wrong provider");
      }
      ({ uploadId } = session);
    },
    begin(meta) {
      ({ contentType } = meta);
      server.uploadIds += 1;
      uploadId = `upload-${server.uploadIds}`;
      server.partSessions.set(uploadId, new Map());
      return Promise.resolve({
        bucket: "fake",
        key,
        partSize,
        provider: "s3",
        uploadId,
      } satisfies ResumableUploadSession);
    },
    complete(parts: PartMeta[]) {
      const session = server.partSessions.get(uploadId as string);
      if (!session) {
        throw new Error("no session");
      }
      const ordered = parts.map((p) => session.get(p.partNumber) as Uint8Array);
      const total = ordered.reduce((sum, b) => sum + b.byteLength, 0);
      const bytes = concat(ordered, total);
      server.objects.set(key, { bytes, contentType });
      return Promise.resolve({ contentType, etag: "done", key, size: total });
    },
    discard() {
      stats.discarded = true;
      if (uploadId) {
        server.partSessions.delete(uploadId);
      }
      return Promise.resolve();
    },
    mode: "parts",
    partSize,
    probe() {
      const session = server.partSessions.get(uploadId as string);
      const committedParts: PartMeta[] = [...(session ?? new Map())].map(
        ([partNumber, data]: [number, Uint8Array]) => ({
          etag: `etag-${partNumber}`,
          partNumber,
          size: data.byteLength,
        })
      );
      return Promise.resolve({ committedParts });
    },
    uploadPart({ partNumber, data }) {
      stats.uploadCalls += 1;
      maybeFail(server, `${key}:${partNumber}`);
      server.partSessions
        .get(uploadId as string)
        ?.set(partNumber, new Uint8Array(data));
      return Promise.resolve({
        etag: `etag-${partNumber}`,
        partNumber,
        size: data.byteLength,
      });
    },
  };
};

const createOffsetDriver = (
  server: FakeServer,
  key: string,
  opts: ResumableDriverOptions
): OffsetResumableDriver => {
  const stats: DriverStats = { discarded: false, uploadCalls: 0 };
  server.drivers.push(stats);
  const partSize =
    typeof opts.multipart === "object" && opts.multipart.partSize
      ? opts.multipart.partSize
      : 4;
  let uri: string | undefined;
  let contentType = "application/octet-stream";
  return {
    adopt(session) {
      if (session.provider !== "gcs") {
        throw new Error("wrong provider");
      }
      ({ uri } = session);
    },
    begin(meta) {
      ({ contentType } = meta);
      server.uploadIds += 1;
      uri = `uri-${server.uploadIds}`;
      server.offsetSessions.set(uri, { chunks: [], received: 0 });
      return Promise.resolve({
        bucket: "fake",
        key,
        provider: "gcs",
        uri,
      } satisfies ResumableUploadSession);
    },
    complete() {
      const session = server.offsetSessions.get(uri as string);
      if (!session) {
        throw new Error("no session");
      }
      const bytes = concat(session.chunks, session.received);
      server.objects.set(key, { bytes, contentType });
      return Promise.resolve({
        contentType,
        etag: "done",
        key,
        size: session.received,
      });
    },
    discard() {
      stats.discarded = true;
      if (uri) {
        server.offsetSessions.delete(uri);
      }
      return Promise.resolve();
    },
    mode: "offset",
    partSize,
    probe() {
      const session = server.offsetSessions.get(uri as string);
      return Promise.resolve({ nextOffset: session?.received ?? 0 });
    },
    uploadAt({ offset, data }) {
      stats.uploadCalls += 1;
      maybeFail(server, `${key}:${offset}`);
      const session = server.offsetSessions.get(uri as string);
      if (!session) {
        throw new Error("no session");
      }
      session.chunks.push(new Uint8Array(data));
      session.received = offset + data.byteLength;
      return Promise.resolve({ nextOffset: session.received });
    },
  };
};

const unsupported = (): never => {
  throw new Error("not used in resumable tests");
};

const makeFiles = (
  server: FakeServer,
  mode: "parts" | "offset" | "none"
): Files => {
  const adapter: Adapter = {
    copy: unsupported,
    delete: unsupported,
    download: unsupported,
    exists: unsupported,
    head: unsupported,
    list: unsupported,
    name: `fake-${mode}`,
    raw: server,
    ...(mode !== "none" && {
      resumableUpload: (
        key: string,
        opts: ResumableDriverOptions
      ): ResumableDriver =>
        mode === "parts"
          ? createPartsDriver(server, key, opts)
          : createOffsetDriver(server, key, opts),
    }),
    signedUploadUrl: unsupported,
    upload: unsupported,
    url: unsupported,
  };
  return new Files({ adapter });
};

const tick = (): Promise<void> => delay(0);

describe("resumable orchestrator (parts mode)", () => {
  test("fresh upload completes and stores the right bytes", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    // 12 bytes → 3 parts at partSize 4
    const body = "abcdefghijkl";
    const control = new UploadControl();
    const result = await files.upload("file.txt", body, {
      control,
      multipart: { partSize: 4 },
    });

    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
    expect(control.loaded).toBe(12);
    expect(control.total).toBe(12);
    expect(
      new TextDecoder().decode(server.objects.get("file.txt")?.bytes)
    ).toBe(body);
  });

  test("pause holds the upload, resume finishes it", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const body = new Uint8Array(12).fill(7);
    const control = new UploadControl();
    let pausedOnce = false;
    const promise = files.upload("p.bin", body, {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !pausedOnce) {
          pausedOnce = true;
          control.pause();
        }
      },
    });

    await tick();
    await tick();
    expect(control.status).toBe("paused");
    expect(control.loaded).toBe(4);
    expect(server.objects.has("p.bin")).toBe(false);

    control.resume();
    const result = await promise;
    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
  });

  test("toJSON token resumes in a fresh control, uploading only missing parts", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const body = new Uint8Array(12).fill(3);

    const first = new UploadControl();
    let paused = false;
    const pending = files
      .upload("r.bin", body, {
        control: first,
        multipart: { concurrency: 1, partSize: 4 },
        onProgress: ({ loaded }) => {
          if (loaded === 4 && !paused) {
            paused = true;
            first.pause();
          }
        },
      })
      .catch(() => {
        // Abandoned in favor of the resumed control below.
      });
    await tick();
    await tick();

    const token = structuredClone(first.toJSON()) as ResumableUploadSession;
    expect(token.provider).toBe("s3");
    expect(server.drivers[0]?.uploadCalls).toBe(1);

    const resumed = UploadControl.from(token);
    const result = await files.upload("r.bin", body, {
      control: resumed,
      multipart: { concurrency: 1, partSize: 4 },
    });

    expect(result.size).toBe(12);
    // The second driver only uploaded parts 2 and 3 — part 1 was already there.
    expect(server.drivers[1]?.uploadCalls).toBe(2);
    expect(server.objects.get("r.bin")?.bytes.every((b) => b === 3)).toBe(true);
    // Clean up the abandoned (paused) first upload.
    await first.abort();
    await pending;
  });

  test("abort() rejects, discards the session, and clears the token", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const body = new Uint8Array(12).fill(9);
    const control = new UploadControl();
    let abortDone: Promise<void> | undefined;
    const promise = files.upload("a.bin", body, {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !abortDone) {
          abortDone = control.abort();
        }
      },
    });

    await expect(promise).rejects.toMatchObject({ aborted: true });
    await abortDone;
    expect(control.status).toBe("aborted");
    expect(control.toJSON()).toBeUndefined();
    expect(server.drivers[0]?.discarded).toBe(true);
    expect(server.objects.has("a.bin")).toBe(false);
  });

  test("a transient part failure is retried", async () => {
    const server = newServer();
    // part 2 fails once
    server.fail.set("retry.bin:2", 1);
    const files = makeFiles(server, "parts");
    const body = new Uint8Array(12).fill(1);
    const result = await files.upload("retry.bin", body, {
      control: new UploadControl(),
      multipart: { concurrency: 1, partSize: 4 },
      retries: 2,
    });
    expect(result.size).toBe(12);
  });

  test("an empty body uploads a single part", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const result = await files.upload("empty.bin", new Uint8Array(0), {
      control: new UploadControl(),
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(0);
    expect(server.objects.get("empty.bin")?.bytes.byteLength).toBe(0);
  });

  test("a part failure with no retries left rejects the upload", async () => {
    const server = newServer();
    // fails more times than retries allows
    server.fail.set("hard.bin:1", 5);
    const files = makeFiles(server, "parts");
    await expect(
      files.upload("hard.bin", new Uint8Array(8), {
        control: new UploadControl(),
        multipart: { concurrency: 1, partSize: 4 },
      })
    ).rejects.toThrow(/transient/u);
  });

  test("a failed part stops sibling workers and pins status at error", async () => {
    const server = newServer();
    // Part 2 fails permanently (more failures than any retry budget here).
    server.fail.set("halt.bin:2", 1000);
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    // 8 parts of 4 bytes, two workers.
    await expect(
      files.upload("halt.bin", new Uint8Array(32), {
        control,
        multipart: { concurrency: 2, partSize: 4 },
        retries: 0,
      })
    ).rejects.toThrow(/transient/u);

    expect(control.status).toBe("error");
    const [stats] = server.drivers;
    const callsAtRejection = stats?.uploadCalls ?? 0;
    // The failure latch stops new dispatches: nowhere near all 8 parts were
    // attempted by the time the upload rejected.
    expect(callsAtRejection).toBeLessThan(8);

    // Nothing keeps uploading in the background after rejection…
    await tick();
    await tick();
    expect(stats?.uploadCalls ?? 0).toBe(callsAtRejection);
    // …and resume() can't resurrect the dead run or flip its status back.
    control.resume();
    await tick();
    await tick();
    expect(stats?.uploadCalls ?? 0).toBe(callsAtRejection);
    expect(control.status).toBe("error");
  });

  test("a part failure wakes a worker parked in pause()", async () => {
    // Deterministic ordering: worker A finishes part 1, the control pauses,
    // A parks on the pause gate picking up part 3; only then is worker B's
    // hung part 2 released to fail. The run must wake A and reject without
    // ever needing a resume().
    const server = newServer();
    const gate = Promise.withResolvers<null>();
    const adapter: Adapter = {
      copy: unsupported,
      delete: unsupported,
      download: unsupported,
      exists: unsupported,
      head: unsupported,
      list: unsupported,
      name: "fake-parked",
      raw: server,
      resumableUpload: (key, opts) => {
        const inner = createPartsDriver(server, key, opts);
        return {
          ...inner,
          async uploadPart(part) {
            if (part.partNumber === 2) {
              await gate.promise;
              throw new Error("permanent part-2 failure");
            }
            return inner.uploadPart(part);
          },
        };
      },
      signedUploadUrl: unsupported,
      upload: unsupported,
      url: unsupported,
    };
    const files = new Files({ adapter });
    const control = new UploadControl();
    let paused = false;
    const promise = files.upload("parked.bin", new Uint8Array(16), {
      control,
      multipart: { concurrency: 2, partSize: 4 },
      onProgress: ({ loaded }) => {
        // Pause as soon as part 1 lands, so worker A parks on its next pick.
        if (loaded >= 4 && !paused) {
          paused = true;
          control.pause();
        }
      },
      retries: 0,
    });
    // Give worker A time to park on the pause gate, then fail part 2.
    await tick();
    await tick();
    expect(control.status).toBe("paused");
    gate.resolve(null);
    await expect(promise).rejects.toThrow(/permanent part-2 failure/u);
    expect(control.status).toBe("error");
  });

  test("abort() racing begin() still discards the fresh session", async () => {
    const server = newServer();
    const started = Promise.withResolvers<null>();
    const gate = Promise.withResolvers<null>();
    const adapter: Adapter = {
      copy: unsupported,
      delete: unsupported,
      download: unsupported,
      exists: unsupported,
      head: unsupported,
      list: unsupported,
      name: "fake-race",
      raw: server,
      resumableUpload: (key, opts) => {
        const inner = createPartsDriver(server, key, opts);
        return {
          ...inner,
          async begin(meta) {
            started.resolve(null);
            await gate.promise;
            return inner.begin(meta);
          },
        };
      },
      signedUploadUrl: unsupported,
      upload: unsupported,
      url: unsupported,
    };
    const files = new Files({ adapter });
    const control = new UploadControl();
    const promise = files.upload("race.bin", new Uint8Array(8), {
      control,
      multipart: { partSize: 4 },
    });
    await started.promise;
    // begin() is in flight: abort() finds no discard installed and returns.
    const aborting = control.abort();
    gate.resolve(null);
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    // The session begin() minted must be discarded, not resurrected onto the
    // aborted control as a live token.
    expect(server.drivers[0]?.discarded).toBe(true);
    expect(control.session).toBeUndefined();
    expect(server.partSessions.size).toBe(0);
    expect(control.status).toBe("aborted");
  });

  test("session getter exposes the live token", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    await files.upload("sess.bin", "abcd", {
      control,
      multipart: { partSize: 4 },
    });
    // Completed upload's session getter still reflects the established token.
    expect(control.session?.provider).toBe("s3");
  });
});

describe("resumable orchestrator (offset mode)", () => {
  test("resuming an already-finalized session reports sane progress", async () => {
    // A probe can report a past-the-end sentinel offset (the HTTP driver uses
    // MAX_SAFE_INTEGER for "the session finalized server-side"). Progress
    // must clamp to the body size, not surface the sentinel to onProgress.
    const driver: OffsetResumableDriver = {
      adopt: () => {
        // The token is accepted as-is for this fake.
      },
      begin: () => Promise.reject(new Error("not a fresh upload")),
      complete: () =>
        Promise.resolve({
          contentType: "application/octet-stream",
          key: "done.bin",
          size: 8,
        }),
      discard: () => Promise.resolve(),
      mode: "offset",
      partSize: 4,
      probe: () => Promise.resolve({ nextOffset: Number.MAX_SAFE_INTEGER }),
      uploadAt: () => Promise.reject(new Error("nothing left to upload")),
    };
    const adapter: Adapter = {
      copy: unsupported,
      delete: unsupported,
      download: unsupported,
      exists: unsupported,
      head: unsupported,
      list: unsupported,
      name: "fake-finalized",
      raw: {},
      resumableUpload: () => driver,
      signedUploadUrl: unsupported,
      upload: unsupported,
      url: unsupported,
    };
    const files = new Files({ adapter });
    const loads: number[] = [];
    const uploaded = await files.upload("done.bin", new Uint8Array(8), {
      control: UploadControl.from({
        bucket: "b",
        key: "done.bin",
        provider: "gcs",
        uri: "uri-finalized",
      }),
      multipart: { partSize: 4 },
      onProgress: ({ loaded }) => {
        loads.push(loaded);
      },
    });
    expect(uploaded.size).toBe(8);
    expect(Math.max(...loads)).toBe(8);
  });

  test("fresh sequential upload completes", async () => {
    const server = newServer();
    const files = makeFiles(server, "offset");
    // 12 bytes
    const body = "hello world!";
    const control = new UploadControl();
    const result = await files.upload("o.txt", body, {
      control,
      multipart: { partSize: 5 },
    });
    expect(result.size).toBe(12);
    expect(new TextDecoder().decode(server.objects.get("o.txt")?.bytes)).toBe(
      body
    );
  });

  test("resume continues from the server's next offset", async () => {
    const server = newServer();
    const files = makeFiles(server, "offset");
    const body = new Uint8Array(15).fill(2);
    const first = new UploadControl();
    let paused = false;
    const pending = files
      .upload("ro.bin", body, {
        control: first,
        multipart: { partSize: 5 },
        onProgress: ({ loaded }) => {
          if (loaded === 5 && !paused) {
            paused = true;
            first.pause();
          }
        },
      })
      .catch(() => {
        // Abandoned in favor of the resumed control.
      });
    await tick();
    await tick();

    const token = structuredClone(first.toJSON()) as ResumableUploadSession;
    expect(server.drivers[0]?.uploadCalls).toBe(1);

    const result = await files.upload("ro.bin", body, {
      control: UploadControl.from(token),
      multipart: { partSize: 5 },
    });
    expect(result.size).toBe(15);
    // offsets 5 and 10
    expect(server.drivers[1]?.uploadCalls).toBe(2);
    // Clean up the abandoned (paused) first upload.
    await first.abort();
    await pending;
  });

  test("an empty body finalizes with one empty chunk", async () => {
    const server = newServer();
    const files = makeFiles(server, "offset");
    const result = await files.upload("oe.bin", "", {
      control: new UploadControl(),
    });
    expect(result.size).toBe(0);
    expect(server.drivers[0]?.uploadCalls).toBe(1);
  });
});

describe("resumable guardrails", () => {
  test("an adapter without resumableUpload throws unsupported", async () => {
    const server = newServer();
    const files = makeFiles(server, "none");
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toThrow(/not supported/iu);
  });

  test("a ReadableStream body is rejected", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await expect(
      files.upload("s", stream, { control: new UploadControl() })
    ).rejects.toThrow(/ReadableStream/u);
  });

  test("a control can drive only one upload", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    await files.upload("one.txt", "data", {
      control,
      multipart: { partSize: 4 },
    });
    await expect(
      files.upload("two.txt", "data", { control, multipart: { partSize: 4 } })
    ).rejects.toThrow(/already driven/iu);
  });

  test("aborting before upload rejects immediately without a session", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    await control.abort();
    await expect(
      files.upload("pre.txt", "data", { control })
    ).rejects.toMatchObject({ aborted: true });
    // The driver factory may run, but no provider session is ever opened.
    expect(server.partSessions.size).toBe(0);
    expect(server.uploadIds).toBe(0);
  });

  test("pause()/resume() are no-ops once completed", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    await files.upload("done.txt", "data", {
      control,
      multipart: { partSize: 4 },
    });
    expect(control.status).toBe("completed");
    control.pause();
    control.resume();
    expect(control.status).toBe("completed");
    // abort() after completion is also a no-op.
    await control.abort();
    expect(control.status).toBe("completed");
  });

  test("slicing works across buffered body shapes", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const cases: { name: string; body: Body; size: number }[] = [
      { body: bytes, name: "uint8", size: 8 },
      { body: bytes.buffer, name: "arraybuffer", size: 8 },
      // A non-Uint8Array view exercises the ArrayBuffer.isView slice branch.
      { body: new Uint16Array([1, 2, 3, 4]), name: "uint16", size: 8 },
      // A typed Blob exercises content-type inference from `blob.type`.
      { body: new Blob([bytes], { type: "image/png" }), name: "blob", size: 8 },
    ];
    for (const { name, body, size } of cases) {
      // eslint-disable-next-line no-await-in-loop -- sequential multipart uploads share one mock server's part state
      const result = await files.upload(name, body, {
        control: new UploadControl(),
        multipart: { partSize: 4 },
      });
      expect(result.size).toBe(size);
    }
  });
});
