// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited results is the natural shape here.
import { describe, expect, spyOn, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type { Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { memory } from "../src/memory/index.js";
import { useFile, useList, useSearch } from "../src/svelte/use-files-query.js";
import { useFiles } from "../src/svelte/use-files.js";

const config = (
  adapter: Adapter,
  onUploadComplete?: (ctx: { file: { key: string } }) => unknown
) => {
  const router = createFilesRouter({
    allowedOrigins: () => true,
    files: createFiles({ adapter }),
    onUploadComplete,
    operations: [
      "head",
      "exists",
      "list",
      "search",
      "url",
      "download",
      "upload",
      "delete",
      "copy",
      "move",
      "capabilities",
      "signedUploadUrl",
    ],
    secret: "svelte-secret",
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    router.handle(new Request(input, init))) as typeof fetch;
  const transport: Transport = async (req) => {
    const raw = req.body as Blob | Uint8Array<ArrayBuffer> | null;
    const total = raw instanceof Blob ? raw.size : (raw?.byteLength ?? 0);
    req.onProgress?.(total, total);
    const res = await router.handle(
      new Request(req.url, {
        body: raw,
        headers: req.headers,
        method: req.method,
      })
    );
    return { status: res.status, text: await res.text() };
  };
  return { endpoint: "https://app.test/api/files", fetchImpl, transport };
};

/** Read a Svelte store's current value synchronously. */
const read = <T>(store: {
  subscribe: (run: (value: T) => void) => () => void;
}): T => {
  let value: T | undefined;
  const unsubscribe = store.subscribe((v) => {
    value = v;
  });
  unsubscribe();
  return value as T;
};

const flush = async (): Promise<void> => {
  await Bun.sleep(0);
  await Bun.sleep(0);
};

describe("svelte useFiles", () => {
  test("uploads and surfaces ambient stores", async () => {
    const files = useFiles(config(memory()));
    expect(read(files.isUploading)).toBe(false);

    const outcome = await files.upload(
      new File(["hello"], "h.txt", { type: "text/plain" })
    );
    expect(outcome.size).toBe(5);
    expect(read(files.isUploading)).toBe(false);
    expect(read(files.uploads).at(-1)?.status).toBe("success");
    expect(read(files.progress).fraction).toBe(1);
    expect(read(files.error)).toBeUndefined();
  });

  test("upload results and uploads entries carry onUploadComplete data", async () => {
    const files = useFiles<{ row: string }>(
      config(memory(), ({ file }) => ({ row: file.key }))
    );
    const outcome = await files.upload(new File(["hi"], "a.txt"));
    expect(outcome.data).toEqual({ row: outcome.key });
    expect(read(files.uploads).at(-1)?.data).toEqual({ row: outcome.key });
  });

  test("exercises every verb and the upload variants", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("seed", "data");
    const files = useFiles(config(adapter));

    await files.upload("k.txt", "v", { contentType: "text/plain" });
    await files.upload([
      { body: "1", key: "m/1" },
      { body: "2", key: "m/2" },
    ]);
    expect(await files.exists("k.txt")).toBe(true);

    const downloaded = await files.download("seed");
    expect(await downloaded.text()).toBe("data");
    const meta = await files.head("k.txt");
    expect(meta.size).toBe(1);
    expect(await files.url("seed")).toContain("memory://");
    await files.copy("seed", "seed-copy");
    await files.move("seed-copy", "seed-moved");
    expect((await files.capabilities()).delimiter).toBe("any");
    expect((await files.signedUploadUrl("sig", { expiresIn: 60 })).method).toBe(
      "PUT"
    );

    expect((await files.list({ prefix: "m/" })).items).toHaveLength(2);
    expect((await files.head(["m/1", "m/2"])).results).toHaveLength(2);
    expect((await files.exists(["m/1", "nope"])).existing).toEqual(["m/1"]);

    const seen: string[] = [];
    for await (const f of files.listAll()) {
      seen.push(f.key);
    }
    expect(seen).toContain("seed");
    const matched: string[] = [];
    for await (const f of files.search("m/*")) {
      matched.push(f.key);
    }
    expect(matched).toHaveLength(2);

    expect((await files.delete(["m/1", "m/2"])).results).toEqual([
      "m/1",
      "m/2",
    ]);
  });

  test("notifies active subscribers as state changes", async () => {
    const files = useFiles(config(memory()));
    const seen: boolean[] = [];
    const unsubscribe = files.isUploading.subscribe((value) => {
      seen.push(value);
    });
    await files.upload(new File(["x"], "x.txt"));
    unsubscribe();
    // initial false, then true while in flight, then false again
    expect(seen).toContain(true);
    expect(seen.at(-1)).toBe(false);
  });

  test("captures errors and reset() clears them", async () => {
    const files = useFiles(config(memory()));
    await expect(files.head("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(read(files.error)?.code).toBe("NotFound");
    files.reset();
    expect(read(files.error)).toBeUndefined();
  });

  test("abort() then reset() re-arms", async () => {
    const files = useFiles(config(memory()));
    files.abort();
    files.reset();
    await files.upload("x", "1");
    expect(read(files.error)).toBeUndefined();
  });

  test("merges option + per-call signals and surfaces upload failures", async () => {
    const controller = new AbortController();
    const files = useFiles({ ...config(memory()), signal: controller.signal });
    await files.list({ signal: new AbortController().signal });
    await expect(files.upload("../escape", "x")).rejects.toBeDefined();
    expect(read(files.error)).toBeDefined();
  });
});

describe("svelte useFiles upload ledger and error mirroring", () => {
  test("uploads accumulate across calls; reset() keeps in-flight entries", async () => {
    const base = config(memory());
    const gate = Promise.withResolvers<null>();
    const transport: Transport = async (req) => {
      if (req.url.includes("slow")) {
        await gate.promise;
      }
      return base.transport(req);
    };
    const files = useFiles({ ...base, transport });
    await files.upload(new File(["a"], "a.txt"));
    await files.upload([
      { body: "1", key: "m/1" },
      { body: "2", key: "m/2" },
    ]);
    expect(read(files.uploads).map((u) => u.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    const slow = files.upload("slow.txt", "zzz");
    await Bun.sleep(0);
    files.reset();
    expect(read(files.uploads).map((u) => u.key)).toEqual(["slow.txt"]);
    expect(read(files.isUploading)).toBe(true);
    gate.resolve(null);
    await slow;
    expect(read(files.uploads).map((u) => u.status)).toEqual(["success"]);
    expect(read(files.progress).fraction).toBe(1);
  });

  test("plugin verbs and listAll/search failures reach error", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["head"],
      secret: "s",
    });
    const files = useFiles({
      endpoint: "https://app.test/api/files",
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        router.handle(new Request(input, init))) as typeof fetch,
    });
    const calls: [string, () => Promise<unknown>][] = [
      ["versions", () => files.versions("k")],
      ["restoreVersion", () => files.restoreVersion("k", "v")],
      ["trashed", () => files.trashed()],
      ["restoreTrashed", () => files.restoreTrashed("k")],
      ["purge", () => files.purge()],
      [
        "listAll",
        async () => {
          for await (const _file of files.listAll()) {
            // drain
          }
        },
      ],
      [
        "search",
        async () => {
          for await (const _file of files.search("*")) {
            // drain
          }
        },
      ],
    ];
    for (const [verb, call] of calls) {
      files.reset();
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      await expect(call()).rejects.toBeDefined();
      expect([verb, read(files.error)?.code]).toEqual([verb, "Unauthorized"]);
    }
  });
});

// A list call that hangs until aborted, recording whether it was.
const hangingConfig = () => {
  const aborted: boolean[] = [];
  let calls = 0;
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    // oxlint-disable-next-line promise/avoid-new -- settles only on abort
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted.push(true);
        reject(new Error("aborted"));
      });
    });
  }) as typeof fetch;
  return {
    aborted,
    calls: () => calls,
    config: { endpoint: "https://app.test/api/files", fetchImpl },
  };
};

describe("svelte query lifecycle", () => {
  test("the last subscriber leaving aborts the in-flight query", async () => {
    const { aborted, config: cfg } = hangingConfig();
    const list = useList({}, cfg);
    // A component's `$data`/`$isLoading` subscriptions outlive the tick.
    const offData = list.data.subscribe(() => {});
    const offLoading = list.isLoading.subscribe(() => {});
    await flush();
    offData();
    expect(aborted).toEqual([]);
    offLoading();
    expect(aborted).toEqual([true]);
  });

  test("a synchronous peek does not abort; resubscribing re-runs an idled query", async () => {
    const { aborted, calls, config: cfg } = hangingConfig();
    const list = useList({}, cfg);
    read(list.isLoading);
    await flush();
    expect(aborted).toEqual([]);

    const off = list.data.subscribe(() => {});
    await flush();
    off();
    expect(aborted).toEqual([true]);
    const before = calls();
    const again = list.data.subscribe(() => {});
    await flush();
    expect(calls()).toBe(before + 1);
    again();
  });

  test("a settled query is left alone when its subscribers leave", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("docs/a", "1");
    const list = useList({ prefix: "docs/" }, config(adapter));
    const off = list.data.subscribe(() => {});
    await flush();
    off();
    expect(read(list.data)?.items).toHaveLength(1);
    expect(read(list.isFetching)).toBe(false);
  });

  test("subscribing the same callback twice yields independent unsubscribes", () => {
    const list = useList({}, { enabled: false });
    const values: unknown[] = [];
    const run = (value: unknown) => values.push(value);
    const first = list.data.subscribe(run);
    const second = list.data.subscribe(run);
    first();
    first();
    second();
    expect(values).toHaveLength(2);
  });
});

describe("svelte reactive query stores", () => {
  test("useList loads and refetches", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("docs/a", "1");
    const list = useList({ prefix: "docs/" }, config(adapter));
    expect(read(list.isLoading)).toBe(true);
    await flush();
    expect(read(list.data)?.items).toHaveLength(1);

    await createFiles({ adapter }).upload("docs/b", "2");
    list.refetch();
    await flush();
    expect(read(list.data)?.items).toHaveLength(2);
  });

  test("useFile is disabled without a key, then loads on refetch", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("f.txt", "data");
    const disabled = useFile(undefined, config(adapter));
    await flush();
    expect(read(disabled.data)).toBeUndefined();
    expect(read(disabled.isFetching)).toBe(false);

    const file = useFile("f.txt", config(adapter));
    await flush();
    expect(read(file.data)?.size).toBe(4);
  });

  test("useSearch collects matches (string and regex)", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("x/1", "a");
    await createFiles({ adapter }).upload("x/2", "b");
    const glob = useSearch("x/*", {}, config(adapter));
    await flush();
    expect(read(glob.data)).toHaveLength(2);

    const re = useSearch(/x\/1/u, {}, config(adapter));
    await flush();
    expect(read(re.data)).toHaveLength(1);
  });

  test("a query surfaces an error", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: [],
      secret: "s",
    });
    const list = useList(
      {},
      {
        endpoint: "https://app.test/api/files",
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
          router.handle(new Request(input, init))) as typeof fetch,
      }
    );
    await flush();
    expect(read(list.error)).toBeDefined();
  });
});

// A fetch that never answers, rejecting with its signal's reason once that
// aborts — what the platform's fetch does.
const pendingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
  // oxlint-disable-next-line promise/avoid-new -- settles only on abort
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason));
  })) as typeof fetch;

const ENDPOINT = "https://app.test/api/files";

describe("svelte errors are FilesErrors", () => {
  test("abort() rejects an in-flight verb with an aborted FilesError and records it", async () => {
    const files = useFiles({ endpoint: ENDPOINT, fetchImpl: pendingFetch });
    const pending = files.list();
    files.abort(new Error("stop"));
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FilesError);
    expect(caught).toMatchObject({
      aborted: true,
      message: "Operation aborted: stop",
    });
    expect(read(files.error)).toBe(caught as FilesError);
  });
});

describe("svelte queries honor the binding-level signal", () => {
  test("an already-aborted signal settles the query with an aborted error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const list = useList(
      {},
      { endpoint: ENDPOINT, fetchImpl: pendingFetch, signal: controller.signal }
    );
    await flush();
    expect(read(list.isFetching)).toBe(false);
    expect(read(list.error)).toMatchObject({
      aborted: true,
      message: "Operation aborted: gone",
    });
  });

  test("aborting mid-flight cancels the request and detaches", async () => {
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    const hits = useSearch(
      "*",
      {},
      { endpoint: ENDPOINT, fetchImpl: pendingFetch, signal: controller.signal }
    );
    expect(read(hits.isFetching)).toBe(true);
    expect(added).toHaveBeenCalledTimes(1);
    controller.abort(new Error("stop"));
    await flush();
    expect(read(hits.isFetching)).toBe(false);
    expect(read(hits.error)?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });

  test("an idle abort cancels without settling and drops the listener", async () => {
    const { signal } = new AbortController();
    const added = spyOn(signal, "addEventListener");
    const removed = spyOn(signal, "removeEventListener");
    const file = useFile("k", {
      endpoint: ENDPOINT,
      fetchImpl: pendingFetch,
      signal,
    });
    const off = file.data.subscribe(() => {});
    await flush();
    off();
    await flush();
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
    expect(read(file.error)).toBeUndefined();
  });
});
