import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import { GraphError } from "@microsoft/microsoft-graph-client";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";
import { mapGraphError, onedrive } from "../src/onedrive/index.js";

interface FakeItem {
  id: string;
  name: string;
  size: number;
  eTag?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  mimeType?: string;
  isFolder?: boolean;
  bytes?: Buffer;
}

const STABLE_MODIFIED = "2024-01-02T03:04:05.000Z";
const STABLE_MODIFIED_MS = new Date(STABLE_MODIFIED).getTime();

// keyed by virtual path under root
let store: Map<string, FakeItem>;
let nextId = 0;
const newId = (): string => {
  nextId += 1;
  return `id-${nextId}`;
};

const parseItemPath = (
  apiPath: string
): { virtualPath: string; suffix?: string } | null => {
  // Strip whichever base prefix the adapter generated:
  //   /me/drive | /drives/{id} | /sites/{id}/drive | /users/{id}/drive
  // and parse the remaining /root[:/path:][/suffix] tail. Examples:
  //   .../root:/docs/a.txt:               -> { virtualPath: "docs/a.txt" }
  //   .../root:/docs/a.txt:/content       -> { virtualPath: "docs/a.txt", suffix: "content" }
  //   .../root:/docs:/children            -> { virtualPath: "docs",       suffix: "children" }
  //   .../root/children                   -> { virtualPath: "",           suffix: "children" }
  const tail = apiPath.replace(
    /^(?:\/me\/drive|\/drives\/[^/]+|\/sites\/[^/]+\/drive|\/users\/[^/]+\/drive)/u,
    ""
  );
  if (tail === "/root") {
    return { virtualPath: "" };
  }
  if (tail === "/root/children") {
    return { suffix: "children", virtualPath: "" };
  }
  const m = /^\/root:\/([^:]*):(?:\/(.+))?$/u.exec(tail);
  if (!m) {
    return null;
  }
  const [, encoded = "", suffix] = m;
  const virtualPath = encoded
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent)
    .join("/");
  return suffix === undefined ? { virtualPath } : { suffix, virtualPath };
};

const makeItem = (
  virtualPath: string,
  bytes: Buffer,
  contentType: string
): FakeItem => {
  const id = newId();
  const idx = virtualPath.lastIndexOf("/");
  const name = idx === -1 ? virtualPath : virtualPath.slice(idx + 1);
  return {
    bytes,
    eTag: `"etag-${id}"`,
    id,
    lastModifiedDateTime: STABLE_MODIFIED,
    mimeType: contentType,
    name,
    size: bytes.byteLength,
    webUrl: `https://contoso-my.sharepoint.com/personal/u/Documents/${virtualPath}`,
  };
};

const itemToDriveItem = (it: FakeItem) => ({
  "@microsoft.graph.downloadUrl": `https://download.example.com/${it.id}`,
  eTag: it.eTag,
  ...(it.isFolder
    ? { folder: { childCount: 0 } }
    : { file: { mimeType: it.mimeType } }),
  id: it.id,
  lastModifiedDateTime: it.lastModifiedDateTime,
  name: it.name,
  size: it.size,
  webUrl: it.webUrl,
});

const defaultGet = (
  apiPath: string,
  responseType?: string
): Promise<unknown> => {
  const parsed = parseItemPath(apiPath);
  if (!parsed) {
    return Promise.reject(new GraphError(404, "Unknown path"));
  }
  if (parsed.suffix === "children") {
    const folder = parsed.virtualPath;
    const children: FakeItem[] = [];
    for (const [vp, item] of store) {
      if (folder === "") {
        if (!vp.includes("/")) {
          children.push(item);
        }
      } else if (
        vp.startsWith(`${folder}/`) &&
        !vp.slice(folder.length + 1).includes("/")
      ) {
        children.push(item);
      }
    }
    return Promise.resolve({ value: children.map(itemToDriveItem) });
  }
  if (parsed.suffix === "content") {
    const it = store.get(parsed.virtualPath);
    if (!it) {
      return Promise.reject(new GraphError(404, "Not found"));
    }
    if (responseType === "stream") {
      return Promise.resolve(Readable.from(it.bytes ?? Buffer.alloc(0)));
    }
    const buf = it.bytes ?? Buffer.alloc(0);
    return Promise.resolve(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
  }
  if (parsed.suffix === undefined) {
    const it = store.get(parsed.virtualPath);
    if (!it) {
      return Promise.reject(new GraphError(404, "Not found"));
    }
    return Promise.resolve(itemToDriveItem(it));
  }
  return Promise.reject(
    new GraphError(404, `Unsupported GET suffix: ${parsed.suffix}`)
  );
};

const defaultPost = (
  apiPath: string,
  body: unknown,
  responseType?: string
): Promise<unknown> => {
  const parsed = parseItemPath(apiPath);
  if (!parsed) {
    return Promise.reject(new GraphError(404, "Unknown path"));
  }
  if (parsed.suffix === "createUploadSession") {
    return Promise.resolve({
      uploadUrl: `https://upload.example.com/session/${encodeURIComponent(parsed.virtualPath)}`,
    });
  }
  if (parsed.suffix === "createLink") {
    const it = store.get(parsed.virtualPath);
    if (!it) {
      return Promise.reject(new GraphError(404, "Not found"));
    }
    return Promise.resolve({
      link: {
        scope: "anonymous",
        type: "view",
        webUrl: `https://share.example.com/${it.id}`,
      },
    });
  }
  if (parsed.suffix === "copy") {
    const src = store.get(parsed.virtualPath);
    if (!src) {
      return Promise.reject(new GraphError(404, "Not found"));
    }
    const b = body as {
      name: string;
      parentReference: { path: string };
    };
    const parentPath = b.parentReference.path;
    const parentVirtual = parentPath
      .replace(/^\/drive\/root:?\/?/u, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .join("/");
    const dest = parentVirtual ? `${parentVirtual}/${b.name}` : b.name;
    const newItem = makeItem(
      dest,
      src.bytes ?? Buffer.alloc(0),
      src.mimeType ?? "application/octet-stream"
    );
    store.set(dest, newItem);
    if (responseType === "raw") {
      return Promise.resolve(
        new Response(null, {
          headers: {
            Location: `https://copy-monitor.example.com/${newItem.id}`,
          },
          status: 202,
        })
      );
    }
    return Promise.resolve(itemToDriveItem(newItem));
  }
  return Promise.reject(
    new GraphError(404, `Unsupported POST suffix: ${parsed.suffix}`)
  );
};

const bodyToBuffer = (body: unknown): Buffer => {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body));
};

const defaultPut = (
  apiPath: string,
  body: unknown,
  headers: Record<string, string>
): Promise<unknown> => {
  const parsed = parseItemPath(apiPath);
  if (!parsed || parsed.suffix !== "content") {
    return Promise.reject(
      new GraphError(400, `Unsupported PUT path: ${apiPath}`)
    );
  }
  const buf = bodyToBuffer(body);
  const ct = headers["Content-Type"] ?? "application/octet-stream";
  const item = makeItem(parsed.virtualPath, buf, ct);
  store.set(parsed.virtualPath, item);
  return Promise.resolve(itemToDriveItem(item));
};

const defaultDelete = (apiPath: string): Promise<void> => {
  const parsed = parseItemPath(apiPath);
  if (!parsed || parsed.suffix !== undefined) {
    return Promise.reject(
      new GraphError(400, `Unsupported DELETE path: ${apiPath}`)
    );
  }
  if (!store.has(parsed.virtualPath)) {
    return Promise.reject(new GraphError(404, "Not found"));
  }
  store.delete(parsed.virtualPath);
  return Promise.resolve();
};

// Per-method dispatch mocks. Tests can override via .mockImpl() for negative
// paths.
const dispatchGet = mock((path: string, responseType?: string) =>
  defaultGet(path, responseType)
);
const dispatchPost = mock(
  (path: string, body: unknown, responseType?: string) =>
    defaultPost(path, body, responseType)
);
const dispatchPut = mock(
  (path: string, body: unknown, headers: Record<string, string>) =>
    defaultPut(path, body, headers)
);
const dispatchDelete = mock((path: string) => defaultDelete(path));

const makeRequestBuilder = (path: string) => {
  let responseType: string | undefined;
  const headers: Record<string, string> = {};
  const builder = {
    _path: path,
    delete() {
      return dispatchDelete(path);
    },
    filter() {
      return builder;
    },
    get() {
      return dispatchGet(path, responseType);
    },
    getStream() {
      return dispatchGet(path, "stream");
    },
    header(k: unknown, v: unknown) {
      headers[k as string] = v as string;
      return builder;
    },
    patch(_: unknown) {
      throw new Error("PATCH not implemented in test fake");
    },
    post(body: unknown) {
      return dispatchPost(path, body, responseType);
    },
    put(body: unknown) {
      return dispatchPut(path, body, headers);
    },
    query() {
      return builder;
    },
    responseType(t: unknown) {
      responseType = t as string;
      return builder;
    },
    select() {
      return builder;
    },
    skip() {
      return builder;
    },
    top() {
      return builder;
    },
  };
  return builder;
};

const fakeClient = {
  api(path: string) {
    return makeRequestBuilder(path);
  },
};

const baseOpts = { client: fakeClient as never };

beforeEach(() => {
  store = new Map();
  nextId = 0;
  dispatchGet.mockClear();
  dispatchPost.mockClear();
  dispatchPut.mockClear();
  dispatchDelete.mockClear();
});

afterEach(() => {
  // No-op — global fetch is restored per-test where needed.
});

describe("onedrive adapter", () => {
  test("missing auth throws at construction", () => {
    expect(() => onedrive({})).toThrow(/missing auth/iu);
  });

  test("multiple auth shapes throws at construction", () => {
    expect(() =>
      onedrive({
        accessToken: "x",
        client: fakeClient as never,
      })
    ).toThrow(/exactly one/iu);
  });

  test("clientCredentials without driveId/siteId/userId throws", () => {
    expect(() =>
      onedrive({
        clientCredentials: {
          clientId: "c",
          clientSecret: "s",
          tenantId: "t",
        },
      })
    ).toThrow(/driveId.*siteId.*userId|interactive user/iu);
  });

  test("multiple drive targets throws", () => {
    expect(() =>
      onedrive({
        accessToken: "x",
        driveId: "d1",
        siteId: "s1",
      })
    ).toThrow(/at most one/iu);
  });

  test("upload writes content with the right path and content-type", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const result = await files.upload("docs/a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toMatch(/^etag-/u);

    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/me/drive/root:/docs/a.txt:/content");
    expect(putCall?.[2]?.["Content-Type"]).toBe("text/plain");
  });

  test("upload encodes special characters in path segments", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("docs/a b.txt", "x", { contentType: "text/plain" });
    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/me/drive/root:/docs/a%20b.txt:/content");
  });

  test("upload rejects metadata", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { metadata: { foo: "bar" } })
    ).rejects.toThrow(/metadata.*not supported/iu);
  });

  test("upload rejects cacheControl", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl.*not supported/iu);
  });

  test("upload with publicByDefault calls createLink", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hello");
    const linkCall = dispatchPost.mock.calls.find(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).endsWith("/createLink")
    );
    expect(linkCall).toBeDefined();
    const body = linkCall?.[1] as { scope: string; type: string };
    expect(body.scope).toBe("anonymous");
    expect(body.type).toBe("view");
  });

  test("upload over the 250 MiB simple-upload limit uses a chunked session", async () => {
    const originalFetch = globalThis.fetch;
    let chunks = 0;
    globalThis.fetch = ((_input: string | URL | Request) => {
      chunks += 1;
      return Promise.resolve(
        Response.json(
          { eTag: '"big-etag"', name: "big.bin", size: 251 * 1024 * 1024 },
          { status: 200 }
        )
      );
    }) as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      const big = new Uint8Array(251 * 1024 * 1024);
      const r = await files.upload("big.bin", big);
      expect(r.etag).toBe("big-etag");
      expect(r.size).toBe(251 * 1024 * 1024);
      // 251 MiB at the default 10 MiB range = 26 chunked PUTs via fetch.
      expect(chunks).toBe(Math.ceil((251 * 1024 * 1024) / (10 * 1024 * 1024)));
      // The single-request content PUT path is not used for sessions.
      expect(dispatchPut.mock.calls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("multipart: true forces a chunked upload session for small bodies", async () => {
    const originalFetch = globalThis.fetch;
    const ranges: (string | undefined)[] = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      ranges.push(headers["Content-Range"]);
      return Promise.resolve(
        Response.json(
          {
            eTag: '"session-etag"',
            lastModifiedDateTime: new Date(STABLE_MODIFIED_MS).toISOString(),
            name: "doc.bin",
            size: 5,
          },
          { status: 201 }
        )
      );
    }) as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      const r = await files.upload("doc.bin", "hello", { multipart: true });
      const sessionCall = dispatchPost.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).endsWith("/createUploadSession")
      );
      expect(sessionCall).toBeDefined();
      expect(dispatchPut.mock.calls.length).toBe(0);
      expect(r.etag).toBe("session-etag");
      expect(r.size).toBe(5);
      // A 5-byte body fits in one chunk spanning the whole range.
      expect(ranges).toEqual(["bytes 0-4/5"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("upload uses default content-type for binary bodies", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await files.upload("bin.dat", bytes);
    expect(r.contentType).toBe("application/octet-stream");
  });

  test("upload accepts a ReadableStream body and collects all chunks", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("chunk-1-"));
        controller.enqueue(enc.encode("chunk-2"));
        controller.close();
      },
    });
    const r = await files.upload("streamed.txt", stream);
    expect(r.size).toBe("chunk-1-chunk-2".length);
    const f = await files.download("streamed.txt");
    expect(await f.text()).toBe("chunk-1-chunk-2");
  });

  test("upload accepts an ArrayBuffer body", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const ab = new TextEncoder().encode("ab-body").buffer as ArrayBuffer;
    const r = await files.upload("ab.bin", ab);
    expect(r.size).toBe("ab-body".length);
  });

  test("upload accepts a Blob body and inherits its type", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const blob = new Blob(["blob-body"], { type: "application/x-test" });
    const r = await files.upload("blob.dat", blob);
    expect(r.contentType).toBe("application/x-test");
    expect(r.size).toBe("blob-body".length);
  });

  test("download returns bytes and metadata", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("hi");
    expect(f.type).toBe("text/plain");
    expect(f.lastModified).toBe(STABLE_MODIFIED_MS);
    expect(f.etag).toMatch(/^etag-/u);
  });

  test("download (stream) returns a web stream", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "stream-me");
    const f = await files.download("a.txt", { as: "stream" });
    const reader = f.stream().getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
      }
    }
    expect(total).toBe("stream-me".length);
  });

  test("download (stream) with a range reports the slice length", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "0123456789");
    const f = await files.download("a.txt", {
      as: "stream",
      range: { start: 7 },
    });
    // 10-byte object, bytes 7..EOF → 3 bytes.
    expect(f.size).toBe(3);
  });

  test("head returns metadata with lazy body factory", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const f = await files.head("a.txt");
    expect(f.type).toBe("text/plain");
    expect(f.size).toBe(2);
    // head() should not yet have requested /content — only the metadata GET.
    const contentGets = dispatchGet.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith("/content")
    );
    expect(contentGets.length).toBe(0);
    expect(await f.text()).toBe("hi");
    const after = dispatchGet.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).endsWith("/content")
    );
    expect(after.length).toBe(1);
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.exists("a.txt")).resolves.toBe(true);
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete is idempotent on missing keys", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.delete("ghost.txt");
  });

  test("delete removes existing item", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "hi");
    await files.delete("a.txt");
    await expect(files.head("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("list returns immediate-children files only and filters folders", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "x");
    await files.upload("b.txt", "x");
    // Inject a folder directly to verify it gets filtered out.
    store.set("subdir", {
      id: "fold-1",
      isFolder: true,
      name: "subdir",
      size: 0,
    });
    const all = await files.list();
    expect(all.items.map((i) => i.key).toSorted()).toEqual(["a.txt", "b.txt"]);
  });

  test("list applies prefix filter client-side", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("alpha.txt", "x");
    await files.upload("beta.txt", "x");
    const r = await files.list({ prefix: "alp" });
    expect(r.items.map((i) => i.key)).toEqual(["alpha.txt"]);
  });

  test("list propagates @odata.nextLink as cursor", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    dispatchGet.mockImplementationOnce(() =>
      Promise.resolve({
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
        value: [],
      })
    );
    const r = await files.list();
    expect(r.cursor).toBe("https://graph.microsoft.com/v1.0/next-page");
  });

  test("copy creates new item at destination and polls monitor URL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(
        Response.json(
          { status: "completed" },
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        )
      )) as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      await files.upload("from.txt", "hi");
      await files.copy("from.txt", "to.txt");
      const head = await files.head("to.txt");
      expect(head.key).toBe("to.txt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("copy times out when monitor never reports completed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(
        Response.json(
          { percentageComplete: 50, status: "inProgress" },
          {
            headers: { "Content-Type": "application/json" },
            status: 202,
          }
        )
      )) as typeof fetch;
    try {
      const files = new Files({
        adapter: onedrive({ ...baseOpts, copyTimeoutMs: 50 }),
      });
      await files.upload("from.txt", "hi");
      await expect(files.copy("from.txt", "to.txt")).rejects.toThrow(
        /timed out/iu
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("copy maps a failed monitor response to a provider error", async () => {
    // The monitor poll's non-OK branch reads the body for context but guards
    // it with `.catch(() => "")`; force `text()` to reject so that fallback
    // arrow fires and the copy still surfaces a Provider error.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve({
        json: () => Promise.resolve({}),
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: () => Promise.reject(new Error("monitor body errored")),
      })) as unknown as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      await files.upload("from.txt", "hi");
      const err = await files
        .copy("from.txt", "to.txt")
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe("Provider");
      expect((err as FilesError).message).toMatch(
        /copy monitor failed \(500\)/u
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("copy tolerates an unreadable monitor JSON body while polling", async () => {
    // When the monitor returns 202 but its JSON body can't be parsed, the
    // `.catch(() => ({}))` fallback yields an empty status so polling keeps
    // going until the (short) timeout fires.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve({
        json: () => Promise.reject(new Error("not json")),
        ok: true,
        status: 202,
        statusText: "Accepted",
        text: () => Promise.resolve(""),
      })) as unknown as typeof fetch;
    try {
      const files = new Files({
        adapter: onedrive({ ...baseOpts, copyTimeoutMs: 50 }),
      });
      await files.upload("from.txt", "hi");
      await expect(files.copy("from.txt", "to.txt")).rejects.toThrow(
        /timed out/iu
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("copy reports a failed copy operation from the monitor status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(
        Response.json(
          { error: { message: "copy blew up" }, status: "failed" },
          { headers: { "Content-Type": "application/json" }, status: 200 }
        )
      )) as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      await files.upload("from.txt", "hi");
      const err = await files
        .copy("from.txt", "to.txt")
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe("Provider");
      expect((err as FilesError).message).toBe("copy blew up");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("upload session maps a failed chunk PUT to a provider error", async () => {
    // Force the upload-session chunk PUT (plain fetch) to fail with a body
    // whose `text()` rejects, exercising the `.catch(() => "")` fallback.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve({
        ok: false,
        status: 507,
        statusText: "Insufficient Storage",
        text: () => Promise.reject(new Error("chunk body errored")),
      })) as unknown as typeof fetch;
    try {
      const files = new Files({ adapter: onedrive(baseOpts) });
      const err = await files
        .upload("doc.bin", "hello", { multipart: true })
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe("Provider");
      expect((err as FilesError).message).toMatch(
        /upload session chunk failed \(507\)/u
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("url throws when publicByDefault is false", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.url("a.txt")).rejects.toThrow(/publicByDefault/u);
  });

  test("url throws on responseContentDisposition", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/u);
  });

  test("url returns share link when publicByDefault is true", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toMatch(/^https:\/\/share\.example\.com\//u);
  });

  test("signedUploadUrl returns the createUploadSession uploadUrl as PUT", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "text/plain",
      expiresIn: 3600,
      maxSize: 1024,
    });
    expect(out).toEqual({
      headers: { "Content-Type": "text/plain" },
      method: "PUT",
      url: "https://upload.example.com/session/a.txt",
    });
    const sessionCall = dispatchPost.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).endsWith("/createUploadSession")
    );
    expect(sessionCall).toBeDefined();
    const body = sessionCall?.[1] as { item: { name: string } };
    expect(body.item.name).toBe("a.txt");
  });

  test("rootFolderPath nests virtual keys under the configured folder", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, rootFolderPath: "/SDK Storage/" }),
    });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/me/drive/root:/SDK%20Storage/a.txt:/content");
  });

  test("rootFolderPath rejects dot segments in configured roots and keys", async () => {
    expect(() =>
      onedrive({ ...baseOpts, rootFolderPath: "../SDK Storage" })
    ).toThrow(/rootFolderPath must not contain/u);

    const files = new Files({
      adapter: onedrive({ ...baseOpts, rootFolderPath: "SDK Storage" }),
    });
    await expect(files.download("../secret.txt")).rejects.toThrow(
      /key must not contain/u
    );
    await expect(files.upload("docs/../secret.txt", "x")).rejects.toThrow(
      /key must not contain/u
    );
    expect(dispatchGet).not.toHaveBeenCalled();
    expect(dispatchPut).not.toHaveBeenCalled();
  });

  test("driveId option targets /drives/{id}", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, driveId: "drv-123" }),
    });
    await files.upload("a.txt", "hi");
    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/drives/drv-123/root:/a.txt:/content");
  });

  test("siteId option targets /sites/{id}/drive", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, siteId: "site-abc" }),
    });
    await files.upload("a.txt", "hi");
    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/sites/site-abc/drive/root:/a.txt:/content");
  });

  test("userId option targets /users/{id}/drive", async () => {
    const files = new Files({
      adapter: onedrive({ ...baseOpts, userId: "user-xyz" }),
    });
    await files.upload("a.txt", "hi");
    const [putCall] = dispatchPut.mock.calls;
    expect(putCall?.[0]).toBe("/users/user-xyz/drive/root:/a.txt:/content");
  });

  // mapGraphError covers status codes (404/401/403/409/412) and named codes
  // ("itemNotFound", "InvalidAuthenticationToken", "nameAlreadyExists").
  test.each([
    [404, null, "NotFound"],
    [401, null, "Unauthorized"],
    [403, null, "Unauthorized"],
    [409, null, "Conflict"],
    [412, null, "Conflict"],
    [500, null, "Provider"],
    [-1, "itemNotFound", "NotFound"],
    [-1, "InvalidAuthenticationToken", "Unauthorized"],
    [-1, "nameAlreadyExists", "Conflict"],
  ] as const)(
    "mapGraphError classifies status=%p code=%p as %s",
    async (status, code, expectedCode) => {
      const files = new Files({ adapter: onedrive(baseOpts) });
      dispatchGet.mockImplementationOnce(() => {
        const e = new GraphError(status as number, "boom");
        if (code) {
          e.code = code as string;
        }
        return Promise.reject(e);
      });
      const err = await files.head("a.txt").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(expectedCode);
    }
  );

  test("mapGraphError extracts message from GraphError.body.error.message", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    dispatchGet.mockImplementationOnce(() => {
      const e = new GraphError(404, "fallback");
      e.body = { error: { message: "Item not found in drive root." } };
      e.code = "itemNotFound";
      return Promise.reject(e);
    });
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).message).toBe("Item not found in drive root.");
    expect((err as FilesError).code).toBe("NotFound");
  });

  test("mapGraphError classifies plain error objects via statusCode", () => {
    const err = mapGraphError({ message: "missing", statusCode: 404 });
    expect(err).toBeInstanceOf(FilesError);
    expect(err.code).toBe("NotFound");
    expect(err.message).toBe("missing");
  });

  test("mapGraphError falls back to status when statusCode is absent", () => {
    const err = mapGraphError({ message: "no perms", status: 403 });
    expect(err.code).toBe("Unauthorized");
    expect(err.message).toBe("no perms");
  });

  test("mapGraphError uses the code field when no status is provided", () => {
    const err = mapGraphError({ code: "nameAlreadyExists" });
    expect(err.code).toBe("Conflict");
    expect(err.message).toBe("Conflict");
  });

  test("mapGraphError defaults to Provider for opaque errors", () => {
    const err = mapGraphError({});
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("OneDrive error");
  });

  test("mapGraphError passes existing FilesError through unchanged", () => {
    const original = new FilesError("NotFound", "already mapped");
    expect(mapGraphError(original)).toBe(original);
  });
});

describe("onedrive resumable uploads", () => {
  const CHUNK = 320 * 1024;
  let restoreFetch: () => void;
  afterEach(() => {
    restoreFetch?.();
  });
  const installFetch = (
    handler: (url: string, init: RequestInit) => Response
  ): void => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    globalThis.fetch = ((url: string, init: RequestInit = {}) =>
      Promise.resolve(handler(url, init))) as unknown as typeof fetch;
  };
  const driveItem = () =>
    Response.json(
      {
        eTag: '"od-etag"',
        file: { mimeType: "application/octet-stream" },
        lastModifiedDateTime: new Date(STABLE_MODIFIED_MS).toISOString(),
        name: "doc.bin",
        size: CHUNK + 5,
      },
      { status: 201 }
    );

  test("fresh upload creates a session and PUTs chunks", async () => {
    const ranges: string[] = [];
    installFetch((_url, init) => {
      const range =
        (init.headers as Record<string, string>)["Content-Range"] ?? "";
      ranges.push(range);
      return range.startsWith(`bytes 0-${CHUNK - 1}`)
        ? new Response(null, { status: 202 })
        : driveItem();
    });
    const files = new Files({ adapter: onedrive(baseOpts) });
    const control = new UploadControl();
    const result = await files.upload("doc.bin", new Uint8Array(CHUNK + 5), {
      control,
      multipart: { partSize: CHUNK },
    });
    expect(result.etag).toBe("od-etag");
    expect(control.status).toBe("completed");
    expect(ranges).toEqual([
      `bytes 0-${CHUNK - 1}/${CHUNK + 5}`,
      `bytes ${CHUNK}-${CHUNK + 4}/${CHUNK + 5}`,
    ]);
    expect(control.session?.provider).toBe("onedrive");
  });

  test("resume reads nextExpectedRanges then sends the rest", async () => {
    const puts: string[] = [];
    installFetch((_url, init) => {
      if (init.method === "GET") {
        return Response.json({ nextExpectedRanges: [`${CHUNK}-`] });
      }
      puts.push(
        (init.headers as Record<string, string>)["Content-Range"] ?? ""
      );
      return driveItem();
    });
    const files = new Files({ adapter: onedrive(baseOpts) });
    const token: ResumableUploadSession = {
      itemPath: "doc.bin",
      provider: "onedrive",
      uploadUrl: "https://upload.example.com/session/doc.bin",
    };
    const result = await files.upload("doc.bin", new Uint8Array(CHUNK + 5), {
      control: UploadControl.from(token),
      multipart: { partSize: CHUNK },
    });
    expect(result.size).toBe(CHUNK + 5);
    expect(puts).toEqual([`bytes ${CHUNK}-${CHUNK + 4}/${CHUNK + 5}`]);
  });

  test("abort discards the session via DELETE", async () => {
    const methods: string[] = [];
    installFetch((_url, init) => {
      methods.push(init.method ?? "GET");
      if (init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      const range =
        (init.headers as Record<string, string>)["Content-Range"] ?? "";
      return range.startsWith(`bytes 0-${CHUNK - 1}`)
        ? new Response(null, { status: 202 })
        : driveItem();
    });
    const files = new Files({ adapter: onedrive(baseOpts) });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("ab.bin", new Uint8Array(CHUNK * 2 + 5), {
      control,
      multipart: { partSize: CHUNK },
      onProgress: ({ loaded }) => {
        if (loaded >= CHUNK && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(methods).toContain("DELETE");
  });

  test("metadata is rejected", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("m.bin", "data", {
        control: new UploadControl(),
        metadata: { a: "b" },
      })
    ).rejects.toThrow(/metadata/u);
  });

  test("cacheControl is rejected", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("c.bin", "data", {
        cacheControl: "public",
        control: new UploadControl(),
      })
    ).rejects.toThrow(/cacheControl/u);
  });

  test("a session response missing uploadUrl throws", async () => {
    dispatchPost.mockImplementationOnce(() => Promise.resolve({}));
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("x.bin", "data", { control: new UploadControl() })
    ).rejects.toThrow(/uploadUrl/u);
  });

  test("a failed chunk PUT throws", async () => {
    installFetch(() => new Response("nope", { status: 500 }));
    const files = new Files({ adapter: onedrive(baseOpts) });
    await expect(
      files.upload("x.bin", "hi", { control: new UploadControl(), retries: 0 })
    ).rejects.toThrow(/chunk failed/u);
  });

  test("a failed resume status check throws", async () => {
    installFetch(() => new Response(null, { status: 410 }));
    const files = new Files({ adapter: onedrive(baseOpts) });
    const token: ResumableUploadSession = {
      itemPath: "x.bin",
      provider: "onedrive",
      uploadUrl: "https://upload.example.com/session/x.bin",
    };
    await expect(
      files.upload("x.bin", new Uint8Array(CHUNK + 5), {
        control: UploadControl.from(token),
        multipart: { partSize: CHUNK },
        retries: 0,
      })
    ).rejects.toThrow(/status check failed/u);
  });

  test("resuming a session that already has every byte throws (no drive item)", async () => {
    installFetch((_url, init) => {
      if (init.method === "GET") {
        // Server reports the whole body is already received, so no chunk is
        // sent and the session was never finalized into a drive item.
        return Response.json({ nextExpectedRanges: [`${CHUNK + 5}-`] });
      }
      return driveItem();
    });
    const files = new Files({ adapter: onedrive(baseOpts) });
    const token: ResumableUploadSession = {
      itemPath: "x.bin",
      provider: "onedrive",
      uploadUrl: "https://upload.example.com/session/x.bin",
    };
    await expect(
      files.upload("x.bin", new Uint8Array(CHUNK + 5), {
        control: UploadControl.from(token),
        multipart: { partSize: CHUNK },
      })
    ).rejects.toThrow(/without returning a drive item/u);
  });

  test("resuming a non-onedrive token throws", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const token = {
      bucket: "b",
      key: "x.bin",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });

  test("resuming a mismatched item path throws", async () => {
    const files = new Files({ adapter: onedrive(baseOpts) });
    const token: ResumableUploadSession = {
      itemPath: "other.bin",
      provider: "onedrive",
      uploadUrl: "https://upload.example.com/session/other.bin",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/item path/u);
  });
});
