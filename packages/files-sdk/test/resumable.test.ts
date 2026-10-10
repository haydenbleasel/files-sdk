import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type {
  Adapter,
  Body,
  FilesActionEvent,
  FilesErrorEvent,
  FilesRetryEvent,
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

  test("resume ignores probed parts this body can't have produced", async () => {
    // Azure's uncommitted-block list also returns blocks an abandoned upload
    // to the same blob left behind. Only a part this body's slicing produces,
    // at the size it produces, may be trusted and committed.
    const server = newServer();
    const files = makeFiles(server, "parts");
    server.partSessions.set(
      "stale",
      new Map([
        // This session's own part 1: kept, not re-uploaded.
        [1, new Uint8Array(4).fill(5)],
        // Wrong size for part 2 (a stale block at another size): re-uploaded.
        [2, new Uint8Array(3).fill(1)],
        // Past the body's last part: dropped, never committed.
        [4, new Uint8Array(4).fill(1)],
        // Not a valid part number: dropped.
        [0, new Uint8Array(4).fill(1)],
      ])
    );
    const token: ResumableUploadSession = {
      bucket: "fake",
      key: "s.bin",
      partSize: 4,
      provider: "s3",
      uploadId: "stale",
    };
    const control = UploadControl.from(token);
    const loaded: number[] = [];
    const result = await files.upload("s.bin", new Uint8Array(10).fill(5), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: (progress) => loaded.push(progress.loaded),
    });

    // Parts 2 and 3 uploaded; part 1 reused; parts 0 and 4 never committed.
    expect(server.drivers[0]?.uploadCalls).toBe(2);
    expect(result.size).toBe(10);
    expect(server.objects.get("s.bin")?.bytes).toEqual(
      new Uint8Array(10).fill(5)
    );
    // Progress starts from the trusted part only.
    expect(loaded[0]).toBe(4);
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

  test("abort() landing while complete() is in flight still aborts", async () => {
    const server = newServer();
    const base = makeFiles(server, "parts");
    // Wrap the parts driver so `complete()` takes a while, and trigger
    // `abort()` the moment it starts.
    const control = new UploadControl();
    let abortDone: Promise<void> | undefined;
    const slowComplete: Adapter = {
      ...(base.adapter as Adapter),
      resumableUpload: (key, opts) => {
        const driver = createPartsDriver(server, key, opts);
        return {
          ...driver,
          // Succeeds regardless of the (by then discarded) session, like a
          // provider whose finalize request was already on the wire.
          async complete() {
            abortDone = control.abort();
            await delay(30);
            return { contentType: "x", etag: "late", key, size: 8 };
          },
        };
      },
    };
    const files = new Files({ adapter: slowComplete });

    const promise = files.upload("late.bin", new Uint8Array(8).fill(1), {
      control,
      multipart: { partSize: 4 },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await abortDone;
    expect(control.status).toBe("aborted");
    expect(control.toJSON()).toBeUndefined();
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

  test("a caller signal aborting a paused upload rejects it and keeps the session", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    const caller = new AbortController();
    control.pause();
    const promise = files.upload("sig.bin", new Uint8Array(16), {
      control,
      multipart: { concurrency: 2, partSize: 4 },
      signal: caller.signal,
    });
    await tick();
    await tick();
    expect(control.status).toBe("paused");
    caller.abort(new Error("user cancelled"));
    await expect(promise).rejects.toMatchObject({
      aborted: true,
      message: "Operation aborted: user cancelled",
    });
    // An external abort is not `control.abort()`: the session survives for a
    // later `UploadControl.from(token)` resume, and nothing was uploaded.
    expect(control.status).toBe("error");
    expect(control.session?.provider).toBe("s3");
    expect(server.drivers[0]?.uploadCalls).toBe(0);
    expect(server.drivers[0]?.discarded).toBe(false);
  });

  test("a pause/resume cycle detaches the caller signal's listener", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    const control = new UploadControl();
    const caller = new AbortController();
    let listeners = 0;
    const { signal } = caller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      listeners += 1;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      listeners -= 1;
      remove(...args);
    };
    control.pause();
    const promise = files.upload("cycle.bin", new Uint8Array(8), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      signal,
    });
    await tick();
    await tick();
    const parked = listeners;
    control.resume();
    await promise;
    // The parked worker's abort listener was removed once resume() woke it.
    expect(listeners).toBeLessThan(parked);
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

  test("abort() landing while complete() is in flight still aborts (offset)", async () => {
    const server = newServer();
    const base = makeFiles(server, "offset");
    const control = new UploadControl();
    let abortDone: Promise<void> | undefined;
    const slowComplete: Adapter = {
      ...(base.adapter as Adapter),
      resumableUpload: (key, opts) => {
        const driver = createOffsetDriver(server, key, opts);
        return {
          ...driver,
          async complete() {
            abortDone = control.abort();
            await delay(30);
            return { contentType: "x", etag: "late", key, size: 8 };
          },
        };
      },
    };
    const files = new Files({ adapter: slowComplete });

    const promise = files.upload("late.bin", new Uint8Array(8).fill(1), {
      control,
      multipart: { partSize: 4 },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await abortDone;
    expect(control.status).toBe("aborted");
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

  test("a caller signal aborting a paused offset upload rejects it", async () => {
    const server = newServer();
    const files = makeFiles(server, "offset");
    const control = new UploadControl();
    const caller = new AbortController();
    control.pause();
    const promise = files.upload("osig.bin", new Uint8Array(10), {
      control,
      multipart: { partSize: 5 },
      signal: caller.signal,
    });
    await tick();
    await tick();
    expect(control.status).toBe("paused");
    caller.abort();
    await expect(promise).rejects.toMatchObject({ aborted: true });
    expect(control.status).toBe("error");
    expect(control.session?.provider).toBe("gcs");
    expect(server.drivers[0]?.uploadCalls).toBe(0);
  });

  test("a caller signal aborting a paused empty offset upload rejects it", async () => {
    const server = newServer();
    const files = makeFiles(server, "offset");
    const control = new UploadControl();
    const caller = new AbortController();
    control.pause();
    const promise = files.upload("oempty.bin", "", {
      control,
      signal: caller.signal,
    });
    await tick();
    await tick();
    caller.abort();
    await expect(promise).rejects.toMatchObject({ aborted: true });
    expect(server.drivers[0]?.uploadCalls).toBe(0);
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

const partsToken = (key: string): ResumableUploadSession => ({
  bucket: "fake",
  key,
  partSize: 4,
  provider: "s3",
  uploadId: "upload-persisted",
});

describe("files.abortUpload", () => {
  test("discards a persisted parts session that a restored control can't", async () => {
    const server = newServer();
    server.partSessions.set(
      "upload-persisted",
      new Map([[1, new Uint8Array(4)]])
    );
    const files = makeFiles(server, "parts");
    const token = partsToken("big.bin");

    // A control rebuilt from the token has no adapter until upload() drives
    // it, so its own abort() only marks it aborted.
    const restored = UploadControl.from(token);
    await restored.abort();
    expect(restored.status).toBe("aborted");
    expect(server.partSessions.has("upload-persisted")).toBe(true);

    await files.abortUpload("big.bin", token);
    expect(server.partSessions.has("upload-persisted")).toBe(false);
    expect(server.drivers.at(-1)?.discarded).toBe(true);
  });

  test("discards a persisted offset session", async () => {
    const server = newServer();
    server.offsetSessions.set("uri-persisted", { chunks: [], received: 0 });
    const files = makeFiles(server, "offset");
    await files.abortUpload("doc.bin", {
      bucket: "fake",
      key: "doc.bin",
      provider: "gcs",
      uri: "uri-persisted",
    });
    expect(server.offsetSessions.has("uri-persisted")).toBe(false);
  });

  test("builds the driver for the prefixed key and forwards no upload options", async () => {
    const server = newServer();
    const seen: { key: string; opts: ResumableDriverOptions }[] = [];
    const files = new Files({
      adapter: {
        ...makeFiles(server, "parts").adapter,
        resumableUpload: (key: string, opts: ResumableDriverOptions) => {
          seen.push({ key, opts });
          return createPartsDriver(server, key, opts);
        },
      },
      prefix: "tenant",
    });
    await files.abortUpload("big.bin", partsToken("tenant/big.bin"));
    expect(seen).toEqual([{ key: "tenant/big.bin", opts: {} }]);
  });

  test("a session that's already gone is not an error", async () => {
    const server = newServer();
    const files = new Files({
      adapter: {
        ...makeFiles(server, "parts").adapter,
        resumableUpload: (key: string, opts: ResumableDriverOptions) => ({
          ...createPartsDriver(server, key, opts),
          discard: () =>
            Promise.reject(new FilesError("NotFound", "NoSuchUpload")),
        }),
      },
    });
    await expect(
      files.abortUpload("big.bin", partsToken("big.bin"))
    ).resolves.toBeUndefined();
  });

  test("other discard failures reject", async () => {
    const server = newServer();
    let calls = 0;
    const files = new Files({
      adapter: {
        ...makeFiles(server, "parts").adapter,
        resumableUpload: (key: string, opts: ResumableDriverOptions) => ({
          ...createPartsDriver(server, key, opts),
          discard: () => {
            calls += 1;
            return Promise.reject(new FilesError("Unauthorized", "denied"));
          },
        }),
      },
    });
    await expect(
      files.abortUpload("big.bin", partsToken("big.bin"), {
        retries: { backoff: () => 0, max: 2 },
      })
    ).rejects.toMatchObject({ code: "Unauthorized" });
    // Unauthorized isn't retryable, so the discard ran once.
    expect(calls).toBe(1);
  });

  test("a token for another provider is refused before any discard", async () => {
    const server = newServer();
    server.offsetSessions.set("uri-persisted", { chunks: [], received: 0 });
    const files = makeFiles(server, "parts");
    const refused = await files
      .abortUpload("doc.bin", {
        bucket: "fake",
        key: "doc.bin",
        provider: "gcs",
        uri: "uri-persisted",
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FilesError);
    expect((refused as FilesError).message).toMatch(/wrong provider/u);
    expect(server.drivers[0]?.discarded).toBe(false);
    expect(server.offsetSessions.has("uri-persisted")).toBe(true);
  });

  test("rejects a missing token, an unsupported adapter, and a read-only view", async () => {
    const server = newServer();
    const files = makeFiles(server, "parts");
    await expect(
      files.abortUpload("big.bin", null as unknown as ResumableUploadSession)
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/control\.toJSON\(\)/u),
    });
    await expect(
      makeFiles(server, "none").abortUpload("big.bin", partsToken("big.bin"))
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/not supported/iu),
    });
    await expect(
      files.readonly().abortUpload("big.bin", partsToken("big.bin"))
    ).rejects.toMatchObject({ code: "ReadOnly" });
    expect(server.drivers).toHaveLength(0);
  });

  test("reports through onAction, onError, and onRetry with the caller's key", async () => {
    const server = newServer();
    server.partSessions.set("upload-persisted", new Map());
    const events: FilesActionEvent[] = [];
    const errors: FilesErrorEvent[] = [];
    const retries: FilesRetryEvent[] = [];
    const wrapped: string[] = [];
    let failures = 1;
    const files = new Files({
      adapter: {
        ...makeFiles(server, "parts").adapter,
        resumableUpload: (key: string, opts: ResumableDriverOptions) => {
          const driver = createPartsDriver(server, key, opts);
          return {
            ...driver,
            discard: () => {
              if (failures > 0) {
                failures -= 1;
                return Promise.reject(new FilesError("Provider", "blip"));
              }
              return driver.discard();
            },
          };
        },
      },
      hooks: {
        onAction: (event) => events.push(event),
        onError: (event) => errors.push(event),
        onRetry: (event) => retries.push(event),
      },
      plugins: [
        {
          name: "recording",
          wrap: (op, next) => {
            wrapped.push(op.kind);
            return next(op);
          },
        },
      ],
      prefix: "tenant",
      retries: { backoff: () => 0, max: 1 },
    });

    await files.abortUpload("big.bin", partsToken("tenant/big.bin"));
    expect(server.partSessions.has("upload-persisted")).toBe(false);
    expect(retries).toMatchObject([
      { attempt: 1, key: "big.bin", type: "abortUpload" },
    ]);
    expect(events).toMatchObject([
      { key: "big.bin", status: "success", type: "abortUpload" },
    ]);
    // No receipt-style payload and no plugin hop: it isn't a FilesOperation.
    expect(events[0]?.result).toBeUndefined();
    expect(wrapped).toEqual([]);

    // A refusal (here a missing token) fires onError too.
    events.length = 0;
    await expect(
      files.abortUpload("other.bin", null as unknown as ResumableUploadSession)
    ).rejects.toMatchObject({ code: "Invalid" });
    await expect(
      files.readonly().abortUpload("big.bin", partsToken("tenant/big.bin"))
    ).rejects.toMatchObject({ code: "ReadOnly" });
    expect(
      errors.map((event) => [event.type, event.key, event.error.code])
    ).toEqual([
      ["abortUpload", "other.bin", "Invalid"],
      ["abortUpload", "big.bin", "ReadOnly"],
    ]);
    expect(events).toMatchObject([
      { key: "other.bin", status: "error", type: "abortUpload" },
      { key: "big.bin", status: "error", type: "abortUpload" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Option validation, stalled drivers, and the session calls (begin / probe /
// complete) running under the same timeout, abort, and retry rules as chunks.
// ---------------------------------------------------------------------------

const filesWithDriver = (
  driver: ResumableDriver,
  opts?: { retries?: number; timeout?: number }
): Files =>
  new Files({
    adapter: {
      copy: unsupported,
      delete: unsupported,
      download: unsupported,
      exists: unsupported,
      head: unsupported,
      list: unsupported,
      name: "fake-custom",
      raw: {},
      resumableUpload: () => driver,
      signedUploadUrl: unsupported,
      upload: unsupported,
      url: unsupported,
    },
    ...(opts?.retries !== undefined && {
      retries: { backoff: () => 0, max: opts.retries },
    }),
    ...(opts?.timeout !== undefined && { timeout: opts.timeout }),
  });

const gcsToken: ResumableUploadSession = {
  bucket: "b",
  key: "k",
  provider: "gcs",
  uri: "uri-k",
};

const offsetDriver = (
  overrides: Partial<OffsetResumableDriver> = {}
): OffsetResumableDriver => ({
  adopt: () => {
    // Any token is accepted.
  },
  begin: () => Promise.resolve(gcsToken),
  complete: () => Promise.resolve({ contentType: "x", key: "k", size: 8 }),
  discard: () => Promise.resolve(),
  mode: "offset",
  partSize: 4,
  probe: () => Promise.resolve({ nextOffset: 0 }),
  uploadAt: ({ offset, data }) =>
    Promise.resolve({ nextOffset: offset + data.byteLength }),
  ...overrides,
});

describe("resumable option validation", () => {
  test.each([
    ["parts", { partSize: 0.5 }],
    ["parts", { partSize: -1 }],
    ["parts", { concurrency: 0.5 }],
    ["offset", { partSize: 0.5 }],
    ["offset", { partSize: 0 }],
    ["offset", { concurrency: -2 }],
  ] as const)(
    "%s: multipart %j is Invalid before a session opens",
    async (mode, multipart) => {
      // A fractional part size used to slice empty chunks forever, `-1`
      // dropped the last byte, and a fractional concurrency committed an
      // empty part list.
      const server = newServer();
      const files = makeFiles(server, mode);
      await expect(
        files.upload("v.bin", new Uint8Array(10), {
          control: new UploadControl(),
          multipart,
        })
      ).rejects.toMatchObject({ code: "Invalid", permanent: true });
      expect(server.uploadIds).toBe(0);
      expect(server.objects.size).toBe(0);
    }
  );

  test("a resume token's unusable part size is refused before any chunk", async () => {
    // Azure, S3, and Vercel Blob read the part size back from the token.
    let uploads = 0;
    const driver: PartsResumableDriver = {
      adopt: () => {
        // Accepts the (tampered) token.
      },
      begin: () => Promise.reject(new Error("not a fresh upload")),
      complete: () => Promise.resolve({ contentType: "x", key: "k", size: 0 }),
      discard: () => Promise.resolve(),
      mode: "parts",
      partSize: -1,
      probe: () => Promise.resolve({ committedParts: [] }),
      uploadPart: ({ partNumber, data }) => {
        uploads += 1;
        return Promise.resolve({ partNumber, size: data.byteLength });
      },
    };
    const control = UploadControl.from(partsToken("k"));
    await expect(
      filesWithDriver(driver).upload("k", new Uint8Array(10), { control })
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/part size must be a positive integer/u),
    });
    expect(uploads).toBe(0);
    expect(control.status).toBe("error");
  });
});

describe("resumable drivers that don't make progress", () => {
  test("an offset chunk acknowledged without advancing fails instead of looping", async () => {
    let calls = 0;
    const driver = offsetDriver({
      uploadAt: ({ offset }) => {
        calls += 1;
        return Promise.resolve({ nextOffset: offset });
      },
    });
    await expect(
      filesWithDriver(driver, { retries: 2 }).upload("k", new Uint8Array(8), {
        control: new UploadControl(),
      })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringMatching(/made no progress/u),
    });
    // Treated like any transient chunk failure: re-sent within the budget.
    expect(calls).toBe(3);
  });

  test("an offset driver reporting NaN fails instead of finalizing", async () => {
    let completed = false;
    const driver = offsetDriver({
      complete: () => {
        completed = true;
        return Promise.resolve({ contentType: "x", key: "k", size: 8 });
      },
      uploadAt: () => Promise.resolve({ nextOffset: Number.NaN }),
    });
    await expect(
      filesWithDriver(driver).upload("k", new Uint8Array(8), {
        control: new UploadControl(),
      })
    ).rejects.toMatchObject({ message: expect.stringMatching(/NaN/u) });
    expect(completed).toBe(false);
  });

  test("a stalled chunk that lands on a retry still completes", async () => {
    let calls = 0;
    const driver = offsetDriver({
      uploadAt: ({ offset, data }) => {
        calls += 1;
        return Promise.resolve({
          nextOffset: calls === 1 ? offset : offset + data.byteLength,
        });
      },
    });
    const result = await filesWithDriver(driver, { retries: 1 }).upload(
      "k",
      new Uint8Array(8),
      { control: new UploadControl() }
    );
    expect(result.size).toBe(8);
    expect(calls).toBe(3);
  });

  test("parts that don't rebuild the body are never committed", async () => {
    let completed = false;
    const driver: PartsResumableDriver = {
      adopt: () => {
        // Unused: a fresh upload.
      },
      begin: () => Promise.resolve(partsToken("k")),
      complete: () => {
        completed = true;
        return Promise.resolve({ contentType: "x", key: "k", size: 0 });
      },
      discard: () => Promise.resolve(),
      mode: "parts",
      partSize: 4,
      probe: () => Promise.resolve({ committedParts: [] }),
      // Reports one byte short per part, as a buggy driver might.
      uploadPart: ({ partNumber, data }) =>
        Promise.resolve({ partNumber, size: data.byteLength - 1 }),
    };
    await expect(
      filesWithDriver(driver).upload("k", new Uint8Array(10), {
        control: new UploadControl(),
      })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringMatching(/3 of 3 parts, 7 of 10 bytes/u),
      permanent: true,
    });
    expect(completed).toBe(false);
  });
});

describe("resumable session calls run like chunks", () => {
  test("begin(), probe(), and complete() each receive the attempt's signal", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const driver = offsetDriver({
      begin: ({ signal }) => {
        seen.push(signal);
        return Promise.resolve(gcsToken);
      },
      complete: (_parts, opts) => {
        seen.push(opts?.signal);
        return Promise.resolve({ contentType: "x", key: "k", size: 8 });
      },
      probe: (opts) => {
        seen.push(opts?.signal);
        return Promise.resolve({ nextOffset: 0 });
      },
    });
    const files = filesWithDriver(driver);
    await files.upload("k", new Uint8Array(8), {
      control: new UploadControl(),
    });
    await files.upload("k", new Uint8Array(8), {
      control: UploadControl.from(gcsToken),
    });
    expect(seen).toHaveLength(4);
    for (const signal of seen) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("a hung begin() honors the timeout, and a session it opens late is discarded", async () => {
    let discards = 0;
    let beginSignal: AbortSignal | undefined;
    const driver = offsetDriver({
      begin: async ({ signal }) => {
        beginSignal = signal;
        await delay(40);
        return gcsToken;
      },
      discard: () => {
        discards += 1;
        return Promise.resolve();
      },
    });
    const control = new UploadControl();
    await expect(
      filesWithDriver(driver, { timeout: 10 }).upload("k", new Uint8Array(8), {
        control,
      })
    ).rejects.toMatchObject({ timedOut: true });
    expect(beginSignal?.aborted).toBe(true);
    expect(control.session).toBeUndefined();
    expect(discards).toBe(0);
    await delay(60);
    expect(discards).toBe(1);
  });

  test("a begin() that fails after the timeout leaves nothing to discard", async () => {
    let discards = 0;
    const driver = offsetDriver({
      begin: async () => {
        await delay(30);
        throw new Error("too late anyway");
      },
      discard: () => {
        discards += 1;
        return Promise.resolve();
      },
    });
    await expect(
      filesWithDriver(driver, { timeout: 5 }).upload("k", new Uint8Array(8), {
        control: new UploadControl(),
      })
    ).rejects.toMatchObject({ timedOut: true });
    await delay(50);
    expect(discards).toBe(0);
  });

  test("control.abort() and a caller signal both reject a hung begin()", async () => {
    const hung = offsetDriver({
      begin: () =>
        // oxlint-disable-next-line promise/avoid-new -- a provider call that never settles
        new Promise<ResumableUploadSession>(() => {
          // Never settles: a stuck connection.
        }),
    });
    const control = new UploadControl();
    const viaControl = filesWithDriver(hung).upload("k", new Uint8Array(8), {
      control,
    });
    await tick();
    await control.abort();
    await expect(viaControl).rejects.toMatchObject({ aborted: true });
    expect(control.status).toBe("aborted");

    const caller = new AbortController();
    const viaSignal = filesWithDriver(hung).upload("k", new Uint8Array(8), {
      control: new UploadControl(),
      signal: caller.signal,
    });
    await tick();
    caller.abort();
    await expect(viaSignal).rejects.toMatchObject({ aborted: true });
  });

  test("transient begin() and probe() failures are retried", async () => {
    let begins = 0;
    let probes = 0;
    const driver = offsetDriver({
      begin: () => {
        begins += 1;
        return begins === 1
          ? Promise.reject(new FilesError("Provider", "503 SlowDown"))
          : Promise.resolve(gcsToken);
      },
      probe: () => {
        probes += 1;
        return probes === 1
          ? Promise.reject(new FilesError("Provider", "503 SlowDown"))
          : Promise.resolve({ nextOffset: 4 });
      },
    });
    const files = filesWithDriver(driver, { retries: 1 });
    const fresh = await files.upload("k", new Uint8Array(8), {
      control: new UploadControl(),
    });
    expect(fresh.size).toBe(8);
    expect(begins).toBe(2);
    const resumed = await files.upload("k", new Uint8Array(8), {
      control: UploadControl.from(gcsToken),
    });
    expect(resumed.size).toBe(8);
    expect(probes).toBe(2);
  });

  test("a transient complete() failure is retried", async () => {
    let completes = 0;
    const driver = offsetDriver({
      complete: () => {
        completes += 1;
        return completes === 1
          ? Promise.reject(new FilesError("Provider", "socket hang up"))
          : Promise.resolve({ contentType: "x", key: "k", size: 8 });
      },
    });
    const result = await filesWithDriver(driver, { retries: 2 }).upload(
      "k",
      new Uint8Array(8),
      { control: new UploadControl() }
    );
    expect(result.size).toBe(8);
    expect(completes).toBe(2);
  });

  test("a retried complete() that finds no session says the object may exist", async () => {
    // The first CompleteMultipartUpload committed but its response was lost;
    // the retry gets NoSuchUpload. That must not read as "never uploaded".
    let completes = 0;
    const first = new FilesError("Provider", "socket hang up");
    const driver = offsetDriver({
      complete: () => {
        completes += 1;
        return Promise.reject(
          completes === 1
            ? first
            : new FilesError("NotFound", "NoSuchUpload", undefined, {
                permanent: true,
              })
        );
      },
    });
    const failure = await filesWithDriver(driver, { retries: 3 })
      .upload("k", new Uint8Array(8), { control: new UploadControl() })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "Provider",
      message: expect.stringMatching(/may have committed the object/u),
      permanent: true,
    });
    expect((failure as FilesError).cause).toBe(first);
    // Permanent, so the remaining retry budget isn't spent.
    expect(completes).toBe(2);
  });

  test("a second complete() failure of another kind surfaces as itself", async () => {
    let completes = 0;
    const driver = offsetDriver({
      complete: () => {
        completes += 1;
        return Promise.reject(new FilesError("Provider", `blip ${completes}`));
      },
    });
    await expect(
      filesWithDriver(driver, { retries: 1 }).upload("k", new Uint8Array(8), {
        control: new UploadControl(),
      })
    ).rejects.toMatchObject({ code: "Provider", message: "blip 2" });
  });

  test("a hung complete() honors the timeout", async () => {
    const driver = offsetDriver({
      complete: () =>
        // oxlint-disable-next-line promise/avoid-new -- a provider call that never settles
        new Promise<never>(() => {
          // Never settles.
        }),
    });
    const control = new UploadControl();
    await expect(
      filesWithDriver(driver, { timeout: 10 }).upload("k", new Uint8Array(8), {
        control,
      })
    ).rejects.toMatchObject({ timedOut: true });
    expect(control.status).toBe("error");
  });
});

// Run `fn` after `n` microtask hops: sweeping `n` lands an abort inside a
// provider call, in the hand-off just after it resolves, and later.
const afterMicrotasks = (n: number, fn: () => void): void => {
  if (n === 0) {
    fn();
    return;
  }
  queueMicrotask(() => afterMicrotasks(n - 1, fn));
};

describe("control.abort() at any point around the session calls", () => {
  test("around begin(): rejects as aborted and discards the session exactly once", async () => {
    for (let n = 0; n <= 16; n += 1) {
      const control = new UploadControl();
      let discards = 0;
      const driver = offsetDriver({
        begin: () => {
          afterMicrotasks(n, () => {
            void control.abort();
          });
          return Promise.resolve(gcsToken);
        },
        discard: () => {
          discards += 1;
          return Promise.resolve();
        },
        // Slow chunks keep every swept abort ahead of completion.
        uploadAt: async ({ offset, data }) => {
          await delay(5);
          return { nextOffset: offset + data.byteLength };
        },
      });
      // eslint-disable-next-line no-await-in-loop -- one microtask offset at a time
      await expect(
        filesWithDriver(driver).upload("k", new Uint8Array(8), { control })
      ).rejects.toMatchObject({ aborted: true });
      // eslint-disable-next-line no-await-in-loop -- let a late discard land
      await delay(10);
      expect([n, control.status, control.session, discards]).toEqual([
        n,
        "aborted",
        undefined,
        1,
      ]);
    }
  });

  test("around complete(): either completes or rejects as aborted, never both", async () => {
    for (let n = 0; n <= 16; n += 1) {
      const control = new UploadControl();
      const driver = offsetDriver({
        complete: () => {
          afterMicrotasks(n, () => {
            void control.abort();
          });
          return Promise.resolve({ contentType: "x", key: "k", size: 8 });
        },
      });
      // eslint-disable-next-line no-await-in-loop -- one microtask offset at a time
      const outcome = await filesWithDriver(driver)
        .upload("k", new Uint8Array(8), { control })
        .then(
          () => "completed",
          (error: unknown) =>
            error instanceof FilesError && error.aborted ? "aborted" : "other"
        );
      expect([n, outcome]).toEqual([n, control.status]);
    }
  });
});
