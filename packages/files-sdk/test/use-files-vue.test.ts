import { describe, expect, spyOn, test } from "bun:test";

import type { EffectScope } from "vue";
import { effectScope, nextTick, ref } from "vue";

import { createFilesRouter } from "../src/api/index.js";
import type { Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { memory } from "../src/memory/index.js";
import { useFile, useList, useSearch } from "../src/vue/use-files-query.js";
import { useFiles } from "../src/vue/use-files.js";

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
    secret: "vue-secret",
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

const withScope = async (
  body: (scope: EffectScope) => Promise<void>
): Promise<void> => {
  const scope = effectScope();
  try {
    await scope.run(async () => {
      await body(scope);
    });
  } finally {
    scope.stop();
  }
};

const flush = async (): Promise<void> => {
  await nextTick();
  await Bun.sleep(0);
  await nextTick();
};

/** Poll until `check` stops throwing (async gateway round trips). */
const until = async (check: () => void): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt > 100) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- polling
      await Bun.sleep(1);
    }
  }
};

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

describe("vue useFiles", () => {
  test("upload results and uploads entries carry onUploadComplete data", async () => {
    await withScope(async () => {
      const files = useFiles<{ row: string }>(
        config(memory(), ({ file }) => ({ row: file.key }))
      );
      const outcome = await files.upload(new File(["hi"], "a.txt"));
      expect(outcome.data).toEqual({ row: outcome.key });
      expect(files.uploads.value.at(-1)?.data).toEqual({ row: outcome.key });
    });
  });

  test("uploads and surfaces ambient refs", async () => {
    await withScope(async () => {
      const files = useFiles(config(memory()));
      expect(files.isUploading.value).toBe(false);

      const outcome = await files.upload(
        new File(["hello"], "h.txt", { type: "text/plain" })
      );
      expect(outcome.size).toBe(5);
      expect(files.isUploading.value).toBe(false);
      expect(files.uploads.value.at(-1)?.status).toBe("success");
      expect(files.progress.value.fraction).toBe(1);
      expect(files.error.value).toBeUndefined();
    });
  });

  test("exercises every verb and the upload variants", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("seed", "data");
    await withScope(async () => {
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
      const caps = await files.capabilities();
      expect(caps.delimiter).toBe("any");
      const signed = await files.signedUploadUrl("sig", { expiresIn: 60 });
      expect(signed.method).toBe("PUT");

      const page = await files.list({ prefix: "m/" });
      expect(page.items).toHaveLength(2);
      const heads = await files.head(["m/1", "m/2"]);
      expect(heads.results).toHaveLength(2);
      const existence = await files.exists(["m/1", "nope"]);
      expect(existence.existing).toEqual(["m/1"]);

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

      const removed = await files.delete(["m/1", "m/2"]);
      expect(removed.results).toEqual(["m/1", "m/2"]);
    });
  });

  test("captures errors and reset() clears them", async () => {
    await withScope(async () => {
      const files = useFiles(config(memory()));
      await expect(files.head("missing")).rejects.toMatchObject({
        code: "NotFound",
      });
      expect(files.error.value?.code).toBe("NotFound");
      files.reset();
      expect(files.error.value).toBeUndefined();
    });
  });

  test("abort() then reset() re-arms", async () => {
    await withScope(async () => {
      const files = useFiles(config(memory()));
      files.abort();
      files.reset();
      await files.upload("x", "1");
      expect(files.error.value).toBeUndefined();
    });
  });

  test("merges option + per-call signals and surfaces upload failures", async () => {
    await withScope(async () => {
      const controller = new AbortController();
      const files = useFiles({
        ...config(memory()),
        signal: controller.signal,
      });
      // a per-call signal exercises the merge of root + option + call signals
      await files.list({ signal: new AbortController().signal });
      // an explicit upload to an unsafe key routes through the error path
      await expect(files.upload("../escape", "x")).rejects.toBeDefined();
      expect(files.error.value).toBeDefined();
    });
  });

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
    expect(files.uploads.value.map((u) => u.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    const slow = files.upload("slow.txt", "zzz");
    await Bun.sleep(0);
    files.reset();
    expect(files.uploads.value.map((u) => u.key)).toEqual(["slow.txt"]);
    expect(files.isUploading.value).toBe(true);
    gate.resolve(null);
    await slow;
    expect(files.uploads.value.map((u) => u.status)).toEqual(["success"]);
    expect(files.progress.value.fraction).toBe(1);
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
      expect([verb, files.error.value?.code]).toEqual([verb, "Unauthorized"]);
    }
  });

  test("works without an active effect scope", async () => {
    const files = useFiles(config(memory()));
    await files.upload("loose", "1");
    expect(await files.exists("loose")).toBe(true);
    files.abort();
  });

  test("scope dispose aborts subsequent calls", async () => {
    const base = config(memory());
    // honor the abort signal the composable threads through on dispose
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      init?.signal?.aborted
        ? Promise.reject(new Error("aborted"))
        : base.fetchImpl(input, init)) as typeof fetch;
    const scope = effectScope();
    const files = scope.run(() => useFiles({ ...base, fetchImpl }));
    scope.stop();
    await expect(files?.head("anything")).rejects.toBeDefined();
  });
});

describe("vue reactive query composables", () => {
  test("useList loads, reacts to a getter, and refetches", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("docs/a", "1");
    await createFiles({ adapter }).upload("img/b", "2");
    await withScope(async () => {
      const prefix = ref("docs/");
      const list = useList(() => ({ prefix: prefix.value }), config(adapter));
      expect(list.isLoading.value).toBe(true);
      await flush();
      expect(list.data.value?.items).toHaveLength(1);

      prefix.value = "img/";
      await flush();
      expect(list.data.value?.items).toHaveLength(1);
      expect(list.data.value?.items[0]?.key).toBe("img/b");

      await createFiles({ adapter }).upload("img/c", "3");
      list.refetch();
      await flush();
      expect(list.data.value?.items).toHaveLength(2);
    });
  });

  test("useFile is disabled without a key, then loads", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("f.txt", "data");
    await withScope(async () => {
      const key = ref<string | undefined>(undefined);
      const file = useFile(key, config(adapter));
      await flush();
      expect(file.data.value).toBeUndefined();
      expect(file.isFetching.value).toBe(false);

      key.value = "f.txt";
      await flush();
      expect(file.data.value?.size).toBe(4);
    });
  });

  test("useSearch collects matches (string and regex)", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("x/1", "a");
    await createFiles({ adapter }).upload("x/2", "b");
    await withScope(async () => {
      const glob = useSearch("x/*", {}, config(adapter));
      await flush();
      expect(glob.data.value).toHaveLength(2);

      const re = useSearch(/x\/1/u, {}, config(adapter));
      await flush();
      expect(re.data.value).toHaveLength(1);
    });
  });

  test("a query surfaces an error", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: [],
      secret: "s",
    });
    await withScope(async () => {
      const list = useList(
        {},
        {
          endpoint: "https://app.test/api/files",
          fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
            router.handle(new Request(input, init))) as typeof fetch,
        }
      );
      await flush();
      expect(list.error.value).toBeDefined();
    });
  });
});

describe("vue errors are FilesErrors", () => {
  test("abort() rejects an in-flight verb with an aborted FilesError and records it", async () => {
    await withScope(async () => {
      const files = useFiles({ endpoint: ENDPOINT, fetchImpl: pendingFetch });
      const pending = files.list().catch((error: unknown) => error);
      files.abort(new Error("stop"));
      const caught = await pending;
      expect(caught).toBeInstanceOf(FilesError);
      expect(caught).toMatchObject({
        aborted: true,
        message: "Operation aborted: stop",
      });
      expect(files.error.value).toBe(caught as FilesError);
    });
  });
});

describe("vue query data belongs to one input", () => {
  test("useFile drops the previous key's data on a key change and when disabled", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a.txt", "aaaa");
    await withScope(async () => {
      const key = ref<string | undefined>("a.txt");
      const file = useFile(key, config(adapter));
      await until(() => expect(file.data.value?.key).toBe("a.txt"));

      key.value = "missing.txt";
      await nextTick();
      expect(file.data.value).toBeUndefined();
      expect(file.isLoading.value).toBe(true);
      await until(() => expect(file.isFetching.value).toBe(false));
      expect(file.data.value).toBeUndefined();
      expect(file.error.value?.code).toBe("NotFound");

      key.value = undefined;
      await nextTick();
      expect(file.data.value).toBeUndefined();
      expect(file.error.value).toBeUndefined();
      expect(file.isFetching.value).toBe(false);
    });
  });

  test("a refetch keeps its own data while reloading, and when it fails", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a.txt", "aaaa");
    const base = config(adapter);
    let failing = false;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      failing
        ? Promise.resolve(
            Response.json(
              { error: { code: "Provider", message: "down" } },
              { status: 500 }
            )
          )
        : base.fetchImpl(input, init)) as typeof fetch;
    await withScope(async () => {
      const file = useFile("a.txt", { ...base, fetchImpl });
      await until(() => expect(file.data.value?.key).toBe("a.txt"));
      failing = true;
      file.refetch();
      await nextTick();
      expect(file.isFetching.value).toBe(true);
      expect(file.isLoading.value).toBe(false);
      await until(() => expect(file.error.value?.message).toBe("down"));
      expect(file.data.value?.key).toBe("a.txt");
    });
  });
});

describe("vue queries honor the composable-level signal", () => {
  test("an already-aborted signal settles the query with an aborted error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await withScope(async () => {
      const list = useList(
        {},
        {
          endpoint: ENDPOINT,
          fetchImpl: pendingFetch,
          signal: controller.signal,
        }
      );
      await until(() => expect(list.isFetching.value).toBe(false));
      expect(list.error.value).toMatchObject({
        aborted: true,
        message: "Operation aborted: gone",
      });
    });
  });

  test("aborting mid-flight cancels; dispose detaches from the signal", async () => {
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    const scope = effectScope();
    const hits = scope.run(() =>
      useSearch(
        "*",
        {},
        {
          endpoint: ENDPOINT,
          fetchImpl: pendingFetch,
          signal: controller.signal,
        }
      )
    );
    expect(hits?.isFetching.value).toBe(true);
    const idle = scope.run(() =>
      useFile("k", {
        endpoint: ENDPOINT,
        fetchImpl: pendingFetch,
        signal: controller.signal,
      })
    );
    expect(added).toHaveBeenCalledTimes(2);
    // Disposing the scope cancels without settling, and drops both listeners.
    scope.stop();
    expect(removed).toHaveBeenCalledTimes(2);
    expect(idle?.error.value).toBeUndefined();

    await withScope(async () => {
      const list = useList(
        {},
        {
          endpoint: ENDPOINT,
          fetchImpl: pendingFetch,
          signal: controller.signal,
        }
      );
      controller.abort(new Error("stop"));
      await until(() => expect(list.error.value?.aborted).toBe(true));
      expect(list.isFetching.value).toBe(false);
    });
  });
});
