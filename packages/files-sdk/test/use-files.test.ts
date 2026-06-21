// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited results is the natural shape here.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { Transport } from "../src/client/transport.js";
import type { Adapter, Files } from "../src/index.js";

beforeAll(() => {
  GlobalRegistrator.register();
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
    secret: "react-secret",
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
        body: req.body,
        headers: req.headers,
        method: req.method,
      })
    );
    return { status: res.status, text: await res.text() };
  };
  return { endpoint: "https://app.test/api/files", fetchImpl, transport };
};

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

    // an upload that fails routes through the error path
    await act(async () => {
      await expect(
        result.current.upload("../escape", "x")
      ).rejects.toBeDefined();
    });
    expect(result.current.error).toBeDefined();
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
