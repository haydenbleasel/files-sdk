// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited results is the natural shape here.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { Transport } from "../src/client/transport.js";
import type { Adapter, Files } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

// happy-dom swaps in its own `TransformStream`, which Bun's native
// `ReadableStream#pipeThrough` rejects; the in-process gateway these tests call
// pipes upload bodies through one (it runs server-side for real), so keep Bun's.
const { TransformStream: NativeTransformStream } = globalThis;
beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.TransformStream = NativeTransformStream;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { createFiles } = await import("../src/index.js");
const { createFilesRouter } = await import("../src/api/index.js");
const { memory } = await import("../src/memory/index.js");
const { softDelete } = await import("../src/soft-delete/index.js");
const { versioning } = await import("../src/versioning/index.js");
const { useFiles } = await import("../src/react/use-files.js");
const { useFile, useList, useSearch } =
  await import("../src/react/use-files-query.js");
const React = await import("react");
const { renderToString } = await import("react-dom/server");

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
    secret: "react-secret",
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

const pluginConfig = (files: Files) => {
  const router = createFilesRouter({
    allowedOrigins: () => true,
    files,
    operations: [
      "versions",
      "restoreVersion",
      "trashed",
      "restoreTrashed",
      "purge",
      "delete",
    ],
    secret: "react-secret",
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    router.handle(new Request(input, init))) as typeof fetch;
  const transport: Transport = async (req) => {
    const res = await router.handle(
      new Request(req.url, {
        body: req.body as Blob | Uint8Array<ArrayBuffer> | null,
        headers: req.headers,
        method: req.method,
      })
    );
    return { status: res.status, text: await res.text() };
  };
  return { endpoint: "https://app.test/api/files", fetchImpl, transport };
};

// A transport that only settles when its signal aborts.
const hanging: Transport = (req) =>
  // oxlint-disable-next-line promise/avoid-new -- settles only on abort
  new Promise((_resolve, reject) => {
    req.signal?.addEventListener("abort", () => reject(req.signal?.reason));
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

afterEach(() => cleanup());

describe("useFiles", () => {
  test("uploads and surfaces ambient state", async () => {
    const opts = config(memory());
    const { result } = renderHook(() => useFiles(opts));

    expect(result.current.isUploading).toBe(false);
    let outcome: { key: string; size: number } | undefined;
    await act(async () => {
      outcome = await result.current.upload(
        new File(["hello"], "h.txt", { type: "text/plain" })
      );
    });
    expect(outcome?.size).toBe(5);
    expect(result.current.isUploading).toBe(false);
    expect(result.current.uploads.at(-1)?.status).toBe("success");
    expect(result.current.progress.fraction).toBe(1);
    expect(result.current.error).toBeUndefined();
  });

  test("upload results and uploads entries carry onUploadComplete data", async () => {
    const opts = config(memory(), ({ file }) => ({ row: file.key }));
    const { result } = renderHook(() => useFiles<{ row: string }>(opts));
    let outcome: { key: string; data?: { row: string } } | undefined;
    await act(async () => {
      outcome = await result.current.upload(new File(["hi"], "a.txt"));
    });
    expect(outcome?.data).toEqual({ row: outcome?.key ?? "" });
    expect(result.current.uploads.at(-1)?.data).toEqual(outcome?.data);
  });

  test("download / list verbs work through the hook", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a.txt", "alpha");
    const { result } = renderHook(() => useFiles(config(adapter)));

    let text = "";
    await act(async () => {
      text = await (await result.current.download("a.txt")).text();
    });
    expect(text).toBe("alpha");

    let count = 0;
    await act(async () => {
      count = (await result.current.list()).items.length;
    });
    expect(count).toBe(1);
  });

  test("plugin verbs forward through the hook", async () => {
    const vFiles = createFiles({ adapter: memory(), plugins: [versioning()] });
    await vFiles.upload("n.txt", "v1");
    await vFiles.upload("n.txt", "v2");
    const { result } = renderHook(() => useFiles(pluginConfig(vFiles)));

    let versions: { versionId: string }[] = [];
    await act(async () => {
      versions = await result.current.versions("n.txt");
    });
    expect(versions).toHaveLength(1);
    const [version] = versions;
    await act(async () => {
      await result.current.restoreVersion("n.txt", version?.versionId);
      await result.current.restoreVersion("n.txt");
    });
    expect(result.current.error).toBeUndefined();

    const sFiles = createFiles({ adapter: memory(), plugins: [softDelete()] });
    await sFiles.upload("a.txt", "hi");
    await sFiles.delete("a.txt");
    const { result: trash } = renderHook(() => useFiles(pluginConfig(sFiles)));

    let trashed: { key: string }[] = [];
    await act(async () => {
      trashed = await trash.current.trashed();
    });
    expect(trashed.map((t) => t.key)).toEqual(["a.txt"]);
    await act(async () => {
      await trash.current.restoreTrashed("a.txt");
      await sFiles.delete("a.txt");
      await trash.current.purge("a.txt");
      await sFiles.upload("b.txt", "x");
      await sFiles.delete("b.txt");
      await trash.current.purge();
    });
    expect(trash.current.error).toBeUndefined();
    expect(await trash.current.trashed()).toHaveLength(0);
  });

  test("renders under SSR (server snapshot)", () => {
    const Comp = () => {
      useFiles(config(memory()));
      return null;
    };
    expect(() => renderToString(React.createElement(Comp))).not.toThrow();
  });

  test("captures errors and reset() clears them", async () => {
    const { result } = renderHook(() => useFiles(config(memory())));
    await act(async () => {
      await expect(result.current.head("missing")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
    expect(result.current.error?.code).toBe("NotFound");

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeUndefined();
  });

  test("exercises every verb and the upload variants", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("seed", "data");
    const controller = new AbortController();
    const { result } = renderHook(() =>
      useFiles({ ...config(adapter), signal: controller.signal })
    );

    await act(async () => {
      // upload variants: explicit key, then bulk array
      await result.current.upload("k.txt", "v", { contentType: "text/plain" });
      await result.current.upload([
        { body: "1", key: "m/1" },
        { body: "2", key: "m/2" },
      ]);
    });
    expect(await result.current.exists("k.txt")).toBe(true);

    await act(async () => {
      await result.current.copy("seed", "seed-copy");
      await result.current.move("seed-copy", "seed-moved");
      await result.current.url("seed");
      await result.current.head(["m/1", "m/2"]);
      await result.current.exists(["m/1", "nope"]);
      await result.current.capabilities();
      await result.current.signedUploadUrl("sig", { expiresIn: 60 });
      await result.current.list({ signal: controller.signal });
      await result.current.delete(["m/1", "m/2"]);
    });

    const seen: string[] = [];
    for await (const f of result.current.listAll()) {
      seen.push(f.key);
    }
    expect(seen).toContain("seed");

    const matches: string[] = [];
    for await (const f of result.current.search("k*")) {
      matches.push(f.key);
    }
    expect(matches).toContain("k.txt");
    // The client's `{ truncated }` summary survives the hook's error wrapper.
    const it = result.current.search("k*", { maxResults: 1 });
    let step = await it.next();
    while (!step.done) {
      // oxlint-disable-next-line no-await-in-loop -- drain to the return value
      step = await it.next();
    }
    expect(step.value).toEqual({ truncated: matches.length > 1 });

    // an upload that fails routes through the error path
    await act(async () => {
      await expect(
        result.current.upload("../escape", "x")
      ).rejects.toBeDefined();
    });
    expect(result.current.error).toBeDefined();
  });

  test("uploads accumulate across calls; reset() keeps in-flight entries", async () => {
    const adapter = memory();
    const base = config(adapter);
    const gate = Promise.withResolvers<null>();
    const transport: Transport = async (req) => {
      if (req.url.includes("slow")) {
        await gate.promise;
      }
      return base.transport(req);
    };
    const { result } = renderHook(() => useFiles({ ...base, transport }));

    await act(async () => {
      await result.current.upload(new File(["a"], "a.txt"));
      await result.current.upload("b.txt", "bb");
      await result.current.upload([
        { body: "1", key: "m/1" },
        { body: "2", key: "m/2" },
      ]);
    });
    expect(result.current.uploads.map((u) => u.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ]);
    expect(result.current.uploads.map((u) => u.key)).toEqual([
      expect.any(String),
      "b.txt",
      "m/1",
      "m/2",
    ]);

    let slow: Promise<unknown> = Promise.resolve();
    act(() => {
      slow = result.current.upload("slow.txt", "zzz");
    });
    await waitFor(() => {
      expect(result.current.uploads.at(-1)?.status).toBe("uploading");
    });
    expect(result.current.isUploading).toBe(true);

    act(() => {
      result.current.reset();
    });
    // Finished entries are gone; the running one (and isUploading) stays.
    expect(result.current.uploads.map((u) => u.key)).toEqual(["slow.txt"]);
    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      gate.resolve(null);
      await slow;
    });
    expect(result.current.uploads.map((u) => u.status)).toEqual(["success"]);
    expect(result.current.isUploading).toBe(false);
    expect(result.current.progress.fraction).toBe(1);
  });

  test("an upload stopped by abort() ends as aborted", async () => {
    const base = config(memory());
    const { result } = renderHook(() =>
      useFiles({ ...base, transport: hanging })
    );

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.upload("k.txt", "abc").catch(() => {});
    });
    await waitFor(() => {
      expect(result.current.uploads.at(-1)?.status).toBe("uploading");
    });
    await act(async () => {
      result.current.abort(new Error("stop"));
      await pending;
    });
    expect(result.current.uploads.at(-1)?.status).toBe("aborted");
    expect(result.current.uploads.at(-1)?.error).toBeDefined();
  });

  test("a rejected upload settles its entry as error", async () => {
    const { result } = renderHook(() => useFiles(config(memory())));
    await act(async () => {
      await expect(
        result.current.upload("../escape", "x")
      ).rejects.toBeDefined();
    });
    const [entry] = result.current.uploads;
    expect(entry?.status).toBe("error");
    expect(entry?.error?.code).toBe("Invalid");
    expect(result.current.isUploading).toBe(false);
  });

  test("listAll/search failures reach error", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["head"],
      secret: "s",
    });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      router.handle(new Request(input, init))) as typeof fetch;
    const { result } = renderHook(() =>
      useFiles({ endpoint: "https://app.test/api/files", fetchImpl })
    );
    await act(async () => {
      await expect(async () => {
        for await (const _file of result.current.listAll()) {
          // drain
        }
      }).toThrow();
    });
    expect(result.current.error?.code).toBe("Unauthorized");
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await expect(async () => {
        for await (const _file of result.current.search("*")) {
          // drain
        }
      }).toThrow();
    });
    expect(result.current.error?.code).toBe("Unauthorized");
  });

  test("abort() re-arms after reset", async () => {
    const { result } = renderHook(() => useFiles(config(memory())));
    act(() => {
      result.current.abort();
    });
    act(() => {
      result.current.reset();
    });
    // after reset the hook is usable again
    await act(async () => {
      await result.current.upload("x", "1");
    });
    expect(result.current.error).toBeUndefined();
  });
});

describe("useFiles errors are FilesErrors", () => {
  test("abort() rejects an in-flight verb with an aborted FilesError and records it", async () => {
    const { result } = renderHook(() =>
      useFiles({ ...config(memory()), fetchImpl: pendingFetch })
    );
    let caught: unknown;
    await act(async () => {
      const pending = result.current.list().catch((error: unknown) => {
        caught = error;
      });
      result.current.abort(new Error("stop"));
      await pending;
    });
    expect(caught).toBeInstanceOf(FilesError);
    expect(caught).toMatchObject({
      aborted: true,
      message: "Operation aborted: stop",
    });
    expect(result.current.error).toBe(caught as FilesError);
  });

  test("a network failure rejects with the same FilesError the hook records", async () => {
    const network = new TypeError("Failed to fetch");
    const { result } = renderHook(() =>
      useFiles({
        endpoint: "https://app.test/api/files",
        fetchImpl: (() => Promise.reject(network)) as unknown as typeof fetch,
      })
    );
    let caught: unknown;
    await act(async () => {
      caught = await result.current.head("k").catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(FilesError);
    expect(caught).toMatchObject({
      aborted: false,
      cause: network,
      code: "Provider",
    });
    expect(result.current.error).toBe(caught as FilesError);
  });

  test("a stopOnError bulk upload resolves with nothing left uploading", async () => {
    const base = config(memory());
    const { result } = renderHook(() => useFiles(base));
    let outcome: { results: { key: string }[]; errors?: unknown[] } | undefined;
    await act(async () => {
      outcome = await result.current.upload(
        [
          { body: "1", key: "ok.txt" },
          { body: "2", key: "../escape" },
          { body: "3", key: "later.txt" },
        ],
        { stopOnError: true }
      );
    });
    expect(outcome?.results.map((r) => r.key)).toEqual(["ok.txt"]);
    expect(outcome?.errors).toHaveLength(1);
    expect(result.current.isUploading).toBe(false);
    expect(result.current.uploads.map((u) => u.status)).toEqual([
      "success",
      "error",
      "aborted",
    ]);
  });
});

describe("reactive query data belongs to one input", () => {
  test("useFile never shows the previous key's data, error, or a disabled query's", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a.txt", "aaaa");
    const cfg = config(adapter);
    const renders: { k?: string; data?: string; isLoading: boolean }[] = [];
    const { rerender, result } = renderHook(
      ({ k }: { k: string | undefined }) => {
        const query = useFile(k, cfg);
        renders.push({ data: query.data?.key, isLoading: query.isLoading, k });
        return query;
      },
      { initialProps: { k: "a.txt" as string | undefined } }
    );
    await waitFor(() => expect(result.current.data?.key).toBe("a.txt"));

    rerender({ k: "missing.txt" });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    // Every render for the new key — including the one before the effect ran —
    // was empty and loading until it settled, never showing a.txt.
    const switched = renders.filter((r) => r.k === "missing.txt");
    expect(switched.some((r) => r.data !== undefined)).toBe(false);
    expect(switched[0]?.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.code).toBe("NotFound");

    rerender({ k: "a.txt" });
    await waitFor(() => expect(result.current.data?.key).toBe("a.txt"));
    expect(result.current.error).toBeUndefined();

    rerender({ k: undefined });
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
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
    const { result } = renderHook(() =>
      useFile("a.txt", { ...base, fetchImpl })
    );
    await waitFor(() => expect(result.current.data?.key).toBe("a.txt"));
    failing = true;
    act(() => {
      result.current.refetch();
    });
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.key).toBe("a.txt");
    await waitFor(() => expect(result.current.error?.message).toBe("down"));
    expect(result.current.data?.key).toBe("a.txt");
  });
});

describe("reactive queries honor the hook-level signal", () => {
  test("an already-aborted signal settles the query with an aborted error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    const { result } = renderHook(() =>
      useList(
        {},
        {
          endpoint: "https://app.test/api/files",
          fetchImpl: pendingFetch,
          signal: controller.signal,
        }
      )
    );
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.error).toMatchObject({
      aborted: true,
      message: "Operation aborted: gone",
    });
  });

  test("aborting the signal mid-flight cancels the request", async () => {
    const controller = new AbortController();
    const { result } = renderHook(() =>
      useSearch(
        "*",
        {},
        {
          endpoint: "https://app.test/api/files",
          fetchImpl: pendingFetch,
          signal: controller.signal,
        }
      )
    );
    expect(result.current.isFetching).toBe(true);
    act(() => {
      controller.abort(new Error("stop"));
    });
    await waitFor(() => expect(result.current.error?.aborted).toBe(true));
    expect(result.current.isFetching).toBe(false);
  });

  test("a settled or unmounted query detaches from a long-lived signal", async () => {
    const { signal } = new AbortController();
    const added = spyOn(signal, "addEventListener");
    const removed = spyOn(signal, "removeEventListener");
    const { result, unmount } = renderHook(() =>
      useList({}, { ...config(memory()), signal })
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);

    const pending = renderHook(() =>
      useList(
        {},
        {
          endpoint: "https://app.test/api/files",
          fetchImpl: pendingFetch,
          signal,
        }
      )
    );
    expect(added).toHaveBeenCalledTimes(2);
    pending.unmount();
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[1]?.[1]);
    unmount();
  });
});

describe("reactive query hooks", () => {
  test("useList loads and refetches", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("docs/a", "1");
    const opts = config(adapter);
    const { result } = renderHook(() => useList({ prefix: "docs/" }, opts));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.items).toHaveLength(1);

    await createFiles({ adapter }).upload("docs/b", "2");
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
  });

  test("useList refetches when the endpoint changes", async () => {
    const docs = memory();
    const images = memory();
    const docsFiles = createFiles({ adapter: docs });
    const imagesFiles = createFiles({ adapter: images });
    await docsFiles.upload("d.txt", "1");
    await imagesFiles.upload("i.png", "2");
    const router = createFilesRouter({
      files: (req) =>
        new URL(req.url).searchParams.get("bucket") === "images"
          ? imagesFiles
          : docsFiles,
      operations: ["list"],
      secret: "s",
    });
    const fetchImpl = ((i: RequestInfo | URL, init?: RequestInit) =>
      router.handle(new Request(i, init))) as typeof fetch;
    const { rerender, result } = renderHook(
      ({ endpoint }: { endpoint: string }) =>
        useList({}, { endpoint, fetchImpl }),
      { initialProps: { endpoint: "https://app.test/api/files" } }
    );
    await waitFor(() =>
      expect(result.current.data?.items.map((f) => f.key)).toEqual(["d.txt"])
    );
    rerender({ endpoint: "https://app.test/api/files?bucket=images" });
    // Another bucket's listing is other data: none shows while it loads.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() =>
      expect(result.current.data?.items.map((f) => f.key)).toEqual(["i.png"])
    );
  });

  test("useFile is disabled without a key", () => {
    const { result } = renderHook(() => useFile(undefined, config(memory())));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  test("useFile loads metadata", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("f.txt", "data");
    const { result } = renderHook(() => useFile("f.txt", config(adapter)));
    await waitFor(() => expect(result.current.data?.size).toBe(4));
  });

  test("useSearch collects matches", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("x/1", "a");
    await createFiles({ adapter }).upload("x/2", "b");
    const { result } = renderHook(() => useSearch("x/*", {}, config(adapter)));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
  });

  test("useList surfaces an error", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: [],
      secret: "s",
    });
    const { result } = renderHook(() =>
      useList(
        {},
        {
          endpoint: "https://app.test/api/files",
          fetchImpl: ((i: RequestInfo | URL, init?: RequestInit) =>
            router.handle(new Request(i, init))) as typeof fetch,
        }
      )
    );
    await waitFor(() => expect(result.current.error).toBeDefined());
  });
});
