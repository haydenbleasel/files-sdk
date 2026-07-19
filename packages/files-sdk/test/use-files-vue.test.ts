import { describe, expect, test } from "bun:test";

import type { EffectScope } from "vue";
import { effectScope, nextTick, ref } from "vue";

import { createFilesRouter } from "../src/api/index.js";
import type { Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { useFile, useList, useSearch } from "../src/vue/use-files-query.js";
import { useFiles } from "../src/vue/use-files.js";

const config = (adapter: Adapter) => {
  const router = createFilesRouter({
    allowedOrigins: () => true,
    files: createFiles({ adapter }),
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
    const total =
      req.body instanceof Blob ? req.body.size : (req.body?.byteLength ?? 0);
    req.onProgress?.(total, total);
    const res = await router.handle(
      new Request(req.url, {
        body: req.body,
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

describe("vue useFiles", () => {
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
      expect(caps.delimiter).toBe(true);
      const signed = await files.signedUploadUrl("sig", { expiresIn: 60 });
      expect(signed.method).toBe("PUT");

      const page = await files.list({ prefix: "m/" });
      expect(page.items).toHaveLength(2);
      const heads = await files.head(["m/1", "m/2"]);
      expect(heads.files).toHaveLength(2);
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
      expect(removed.deleted).toEqual(["m/1", "m/2"]);
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
