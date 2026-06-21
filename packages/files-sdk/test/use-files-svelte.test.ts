// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited results is the natural shape here.
import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type { Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { useFile, useList, useSearch } from "../src/svelte/use-files-query.js";
import { useFiles } from "../src/svelte/use-files.js";

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
    secret: "svelte-secret",
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    router.handle(new Request(input, init))) as typeof fetch;
  const transport: Transport = async (req) => {
    req.onProgress?.(req.body?.size ?? 0, req.body?.size ?? 0);
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

/** Read a Svelte store's current value synchronously. */
const read = <T>(store: {
  subscribe(run: (value: T) => void): () => void;
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
    expect((await files.capabilities()).delimiter).toBe(true);
    expect((await files.signedUploadUrl("sig", { expiresIn: 60 })).method).toBe(
      "PUT"
    );

    expect((await files.list({ prefix: "m/" })).items).toHaveLength(2);
    expect((await files.head(["m/1", "m/2"])).files).toHaveLength(2);
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

    expect((await files.delete(["m/1", "m/2"])).deleted).toEqual([
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
