// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited results is the natural shape here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import { createFilesClient } from "../src/client/index.js";
import { aggregate, initialState } from "../src/client/progress.js";
import type { SendRequest, Transport } from "../src/client/transport.js";
import {
  defaultTransport,
  fetchTransport,
  xhrTransport,
} from "../src/client/transport.js";
import type { Adapter, Files } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { memory } from "../src/memory/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { versioning } from "../src/versioning/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const ENDPOINT = "https://app.test/api/files";

// A client whose fetch + upload transport forward into a real gateway, so the
// whole client↔server protocol round-trips against the memory adapter.
const clientFor = (adapter: Adapter, opts: { headers?: HeadersInit } = {}) => {
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
    secret: "client-secret",
  });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    router.handle(new Request(input, init))) as typeof fetch;
  const transport: Transport = async (req: SendRequest) => {
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
  return createFilesClient({
    endpoint: ENDPOINT,
    fetchImpl,
    transport,
    ...opts,
  });
};

describe("createFilesClient — round-trip", () => {
  let adapter: Adapter;
  beforeEach(() => {
    adapter = memory();
  });

  test("keyless upload → download → text/blob", async () => {
    const client = clientFor(adapter);
    const progress: number[] = [];
    const outcome = await client.upload(
      new File(["hello world"], "greeting.txt", { type: "text/plain" }),
      { onProgress: (p) => progress.push(p.fraction) }
    );
    expect(outcome.size).toBe(11);
    expect(progress.at(-1)).toBe(1);

    const file = await client.download(outcome.key);
    expect(await file.text()).toBe("hello world");
    expect((await file.blob()).size).toBe(11);
  });

  test("explicit-key upload + head + url + exists + delete", async () => {
    const client = clientFor(adapter);
    const out = await client.upload("notes/a.txt", "alpha", {
      contentType: "text/plain",
    });
    expect(out.key).toBe("notes/a.txt");

    const head = await client.head("notes/a.txt");
    expect(head.size).toBe(5);
    // lazy body fetches via download
    expect(await head.text()).toBe("alpha");

    expect(await client.url("notes/a.txt")).toContain("memory://");
    expect(await client.exists("notes/a.txt")).toBe(true);
    await client.delete("notes/a.txt");
    expect(await client.exists("notes/a.txt")).toBe(false);
  });

  test("copy / move", async () => {
    const client = clientFor(adapter);
    await client.upload("a", "1");
    await client.copy("a", "b");
    expect(await client.exists("b")).toBe(true);
    await client.move("b", "c");
    expect(await client.exists("b")).toBe(false);
    expect(await client.exists("c")).toBe(true);
  });

  test("download with range", async () => {
    const client = clientFor(adapter);
    await client.upload("r.txt", "hello world");
    const file = await client.download("r.txt", {
      range: { end: 4, start: 0 },
    });
    expect(await file.text()).toBe("hello");
  });

  test("list / listAll / search", async () => {
    const client = clientFor(adapter);
    await client.upload("docs/a", "1");
    await client.upload("docs/b", "2");
    await client.upload("other/c", "3");

    const page = await client.list({ prefix: "docs/" });
    expect(page.items).toHaveLength(2);

    const all: string[] = [];
    for await (const f of client.listAll()) {
      all.push(f.key);
    }
    expect(all).toHaveLength(3);

    const found: string[] = [];
    for await (const f of client.search("docs/*")) {
      found.push(f.key);
    }
    expect(found.toSorted()).toEqual(["docs/a", "docs/b"]);

    const re: string[] = [];
    for await (const f of client.search(/other/u)) {
      re.push(f.key);
    }
    expect(re).toEqual(["other/c"]);
  });

  test("signedUploadUrl + capabilities", async () => {
    const client = clientFor(adapter);
    const signed = await client.signedUploadUrl("k", { expiresIn: 60 });
    expect(signed.method).toBe("PUT");
    const caps = await client.capabilities();
    expect(caps.delimiter).toBe(true);
  });

  test("bulk head / exists / delete / upload / download", async () => {
    const client = clientFor(adapter);
    await client.upload([
      { body: "1", key: "a" },
      { body: "2", key: "b" },
    ]);
    const heads = await client.head(["a", "b"]);
    expect(heads.files).toHaveLength(2);
    const ex = await client.exists(["a", "missing"]);
    expect(ex.existing).toEqual(["a"]);
    const dl = await client.download(["a", "b"]);
    expect(dl.downloaded).toHaveLength(2);
    const del = await client.delete(["a", "b"]);
    expect(del.deleted).toEqual(["a", "b"]);
  });

  test("maps a 404 to a FilesError(NotFound)", async () => {
    const client = clientFor(adapter);
    await expect(client.head("nope")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("auth headers are sent (lazy)", async () => {
    let seen = "";
    const router = createFilesRouter({
      authorize: ({ req }) => {
        seen = req.headers.get("authorization") ?? "";
      },
      files: createFiles({ adapter }),
      operations: ["exists"],
      secret: "s",
    });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: ((i: RequestInfo | URL, init?: RequestInit) =>
        router.handle(new Request(i, init))) as typeof fetch,
      headers: () => ({ authorization: "Bearer xyz" }),
    });
    await client.exists("k");
    expect(seen).toBe("Bearer xyz");
  });
});

describe("createFilesClient — bulk partial failure", () => {
  test("delete-many surfaces per-key errors", async () => {
    const client = clientFor(fakeAdapter() as unknown as Adapter);
    await client.upload("ok", "1");
    const result = await client.delete(["ok", "fail/x"]);
    expect(result.deleted).toEqual(["ok"]);
    expect(result.errors?.[0]?.error).toBeInstanceOf(FilesError);
  });
});

describe("transport seam", () => {
  const okXhr = () => {
    type Listener = (event: ProgressEvent) => void;
    class FakeXHR {
      static instances: FakeXHR[] = [];
      private readonly listeners: Record<string, Listener[]> = {};
      private readonly uploadListeners: Record<string, Listener[]> = {};
      upload = {
        addEventListener: (type: string, handler: Listener) => {
          (this.uploadListeners[type] ??= []).push(handler);
        },
      };
      status = 200;
      responseText = '{"ok":true}';
      method = "";
      url = "";
      headers: Record<string, string> = {};
      body: unknown;
      constructor() {
        FakeXHR.instances.push(this);
      }
      addEventListener(type: string, handler: Listener) {
        (this.listeners[type] ??= []).push(handler);
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send(body: unknown) {
        this.body = body;
        for (const handler of this.uploadListeners.progress ?? []) {
          handler({
            lengthComputable: true,
            loaded: 5,
            total: 5,
          } as ProgressEvent);
        }
        for (const handler of this.listeners.load ?? []) {
          handler({} as ProgressEvent);
        }
      }
      abort() {
        for (const handler of this.listeners.abort ?? []) {
          handler({} as ProgressEvent);
        }
      }
    }
    return FakeXHR;
  };

  afterEach(() => {
    // @ts-expect-error -- test cleanup
    delete globalThis.XMLHttpRequest;
  });

  test("xhrTransport reports progress and returns the body (PUT)", async () => {
    const Fake = okXhr();
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Fake;
    const seen: number[] = [];
    const result = await xhrTransport({
      body: new Blob(["hello"]),
      headers: { "content-type": "text/plain" },
      method: "PUT",
      onProgress: (loaded) => seen.push(loaded),
      url: "https://x.test/put",
    });
    expect(result.status).toBe(200);
    expect(seen).toEqual([5]);
    expect(Fake.instances[0]?.headers["content-type"]).toBe("text/plain");
  });

  test("xhrTransport builds a POST FormData with fields then file", async () => {
    const Fake = okXhr();
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Fake;
    await xhrTransport({
      body: new Blob(["x"]),
      fields: { key: "uploads/x", policy: "p" },
      method: "POST",
      url: "https://s3.test/",
    });
    expect(Fake.instances[0]?.body).toBeInstanceOf(FormData);
    const form = Fake.instances[0]?.body as FormData;
    expect(form.get("key")).toBe("uploads/x");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  test("xhrTransport rejects on an already-aborted signal", () => {
    const Fake = okXhr();
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Fake;
    const controller = new AbortController();
    controller.abort();
    const promise = xhrTransport({
      body: new Blob(["x"]),
      method: "PUT",
      signal: controller.signal,
      url: "https://x.test/put",
    });
    expect(promise).rejects.toMatchObject({ aborted: true });
  });

  test("fetchTransport falls back without progress (PUT + POST)", async () => {
    const calls: { url: string; method?: string }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ method: init.method, url });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof fetch;
    const transport = fetchTransport(fakeFetch);
    const ends: number[] = [];
    await transport({
      body: new Blob(["abc"]),
      method: "PUT",
      onProgress: (l) => ends.push(l),
      url: "https://x.test/put",
    });
    expect(ends).toEqual([0, 3]);
    await transport({
      body: new Blob(["abc"]),
      fields: { a: "1" },
      method: "POST",
      url: "https://x.test/post",
    });
    expect(calls).toHaveLength(2);
  });

  test("defaultTransport picks fetch when XHR is absent", () => {
    expect(typeof defaultTransport(fetch)).toBe("function");
  });
});

describe("progress helpers", () => {
  test("aggregate + initialState", () => {
    const a = initialState(new File(["12345"], "a.txt"));
    a.loaded = 5;
    const b = initialState(new Blob(["123"]));
    expect(aggregate([a, b])).toEqual({ fraction: 5 / 8, loaded: 5, total: 8 });
    expect(aggregate([])).toEqual({ fraction: 0, loaded: 0, total: 0 });
    expect(b.name).toBe("blob");
  });
});

describe("createFilesClient — plugin verbs", () => {
  const pluginClientFor = (files: Files) => {
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
      secret: "client-secret",
    });
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      router.handle(new Request(input, init))) as typeof fetch;
    const transport: Transport = async (req: SendRequest) => {
      const res = await router.handle(
        new Request(req.url, {
          body: req.body as Blob | Uint8Array<ArrayBuffer> | null,
          headers: req.headers,
          method: req.method,
        })
      );
      return { status: res.status, text: await res.text() };
    };
    return createFilesClient({ endpoint: ENDPOINT, fetchImpl, transport });
  };

  test("versions + restoreVersion (with and without an id)", async () => {
    const files = createFiles({ adapter: memory(), plugins: [versioning()] });
    await files.upload("n.txt", "v1");
    await files.upload("n.txt", "v2");
    const client = pluginClientFor(files);

    const versions = await client.versions("n.txt");
    expect(versions).toHaveLength(1);
    const [version] = versions;
    if (!version) {
      throw new Error("expected a version");
    }
    expect((await client.restoreVersion("n.txt", version.versionId)).key).toBe(
      "n.txt"
    );
    expect((await client.restoreVersion("n.txt")).key).toBe("n.txt");
  });

  test("trashed + restoreTrashed + purge (with and without a key)", async () => {
    const files = createFiles({ adapter: memory(), plugins: [softDelete()] });
    await files.upload("a.txt", "hi");
    await files.delete("a.txt");
    const client = pluginClientFor(files);

    expect((await client.trashed()).map((t) => t.key)).toEqual(["a.txt"]);
    expect((await client.restoreTrashed("a.txt")).key).toBe("a.txt");

    await files.delete("a.txt");
    await client.purge("a.txt");
    expect(await client.trashed()).toHaveLength(0);

    await files.upload("b.txt", "x");
    await files.delete("b.txt");
    await client.purge();
    expect(await client.trashed()).toHaveLength(0);
  });
});
