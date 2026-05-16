import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";

import type { Dropbox } from "dropbox";
import { DropboxResponseError } from "dropbox";

import { dropbox } from "../src/dropbox/index.js";
import { Files, FilesError } from "../src/index.js";

interface FakeFile {
  id: string;
  name: string;
  size: number;
  rev: string;
  serverModified: string;
  bytes: Buffer;
}

const STABLE_MODIFIED = "2024-01-02T03:04:05Z";
const STABLE_MODIFIED_MS = new Date(STABLE_MODIFIED).getTime();

let store: Map<string, FakeFile>;
let nextId = 0;
const newId = (): string => {
  nextId += 1;
  return `id:${nextId}`;
};

const keyFromPath = (path: string): string =>
  path.startsWith("/") ? path.slice(1) : path;

// Build a Dropbox-style discriminated error body from a stub summary string
// so the tag-walking classifier sees a representative shape for each case.
const parseSummaryToErrorBody = (summary: string): Record<string, unknown> => {
  if (summary.startsWith("path/")) {
    const leaf = summary.split("/")[1] ?? "other";
    return { ".tag": "path", path: { ".tag": leaf } };
  }
  if (summary.startsWith("path_lookup/")) {
    const leaf = summary.split("/")[1] ?? "other";
    return { ".tag": "path_lookup", path_lookup: { ".tag": leaf } };
  }
  if (summary.startsWith("invalid_access_token")) {
    return { ".tag": "invalid_access_token" };
  }
  if (summary.startsWith("expired_access_token")) {
    return { ".tag": "expired_access_token" };
  }
  if (summary.startsWith("missing_scope")) {
    return { ".tag": "missing_scope", required_scope: "files.content.read" };
  }
  return { ".tag": "other" };
};

const fileMetadataReference = (it: FakeFile, key: string) => ({
  ".tag": "file" as const,
  client_modified: it.serverModified,
  id: it.id,
  name: it.name,
  path_display: `/${key}`,
  path_lower: `/${key}`.toLowerCase(),
  rev: it.rev,
  server_modified: it.serverModified,
  size: it.size,
});

const fileMetadata = (it: FakeFile, key: string) => ({
  client_modified: it.serverModified,
  id: it.id,
  name: it.name,
  path_display: `/${key}`,
  path_lower: `/${key}`.toLowerCase(),
  rev: it.rev,
  server_modified: it.serverModified,
  size: it.size,
});

const makeFile = (key: string, bytes: Buffer): FakeFile => {
  const id = newId();
  const idx = key.lastIndexOf("/");
  const name = idx === -1 ? key : key.slice(idx + 1);
  return {
    bytes,
    id,
    name,
    rev: `rev-${id}`,
    serverModified: STABLE_MODIFIED,
    size: bytes.byteLength,
  };
};

const wrapResult = <T>(result: T) => ({ headers: {}, result, status: 200 });

const responseError = (
  status: number,
  errorBody: unknown
): DropboxResponseError<unknown> =>
  new DropboxResponseError(status, {}, errorBody);

const filesUploadMock = mock(
  (arg: { contents: Buffer; path: string; mode?: { ".tag": string } }) => {
    const key = keyFromPath(arg.path);
    const item = makeFile(key, Buffer.from(arg.contents));
    store.set(key, item);
    return Promise.resolve(wrapResult(fileMetadata(item, key)));
  }
);

const filesDownloadMock = mock((arg: { path: string }) => {
  const key = keyFromPath(arg.path);
  const it = store.get(key);
  if (!it) {
    return Promise.reject(
      responseError(409, {
        error: { ".tag": "path", path: { ".tag": "not_found" } },
        error_summary: "path/not_found/",
      })
    );
  }
  // Mimic SDK by attaching fileBinary onto the result.
  const meta: Record<string, unknown> = {
    ...fileMetadata(it, key),
    fileBinary: it.bytes,
  };
  return Promise.resolve(wrapResult(meta));
});

const filesGetMetadataMock = mock((arg: { path: string }) => {
  const key = keyFromPath(arg.path);
  const it = store.get(key);
  if (!it) {
    return Promise.reject(
      responseError(409, {
        error: { ".tag": "path", path: { ".tag": "not_found" } },
        error_summary: "path/not_found/",
      })
    );
  }
  return Promise.resolve(wrapResult(fileMetadataReference(it, key)));
});

const filesDeleteV2Mock = mock((arg: { path: string }) => {
  const key = keyFromPath(arg.path);
  const it = store.get(key);
  if (!it) {
    return Promise.reject(
      responseError(409, {
        error: { ".tag": "path_lookup", path_lookup: { ".tag": "not_found" } },
        error_summary: "path_lookup/not_found/",
      })
    );
  }
  store.delete(key);
  return Promise.resolve(
    wrapResult({ metadata: fileMetadataReference(it, key) })
  );
});

const filesCopyV2Mock = mock((arg: { from_path: string; to_path: string }) => {
  const fromKey = keyFromPath(arg.from_path);
  const toKey = keyFromPath(arg.to_path);
  const src = store.get(fromKey);
  if (!src) {
    return Promise.reject(
      responseError(409, {
        error: {
          ".tag": "from_lookup",
          from_lookup: { ".tag": "not_found" },
        },
        error_summary: "from_lookup/not_found/",
      })
    );
  }
  const copy = makeFile(toKey, src.bytes);
  store.set(toKey, copy);
  return Promise.resolve(
    wrapResult({ metadata: fileMetadataReference(copy, toKey) })
  );
});

const filesListFolderMock = mock(
  (arg: { path: string; recursive?: boolean; limit?: number }) => {
    const root = arg.path === "" ? "" : keyFromPath(arg.path);
    const entries = [...store.entries()]
      .filter(([k]) => !root || k === root || k.startsWith(`${root}/`))
      .map(([k, it]) => fileMetadataReference(it, k));
    return Promise.resolve(
      wrapResult({ cursor: "next-cursor", entries, has_more: false })
    );
  }
);

const filesListFolderContinueMock = mock((_arg: { cursor: string }) =>
  Promise.resolve(wrapResult({ cursor: "", entries: [], has_more: false }))
);

const filesGetTemporaryLinkMock = mock((arg: { path: string }) => {
  const key = keyFromPath(arg.path);
  const it = store.get(key);
  if (!it) {
    return Promise.reject(
      responseError(409, {
        error: { ".tag": "path", path: { ".tag": "not_found" } },
        error_summary: "path/not_found/",
      })
    );
  }
  return Promise.resolve(
    wrapResult({
      link: `https://content.dropboxapi.com/tmp/${it.id}`,
      metadata: fileMetadata(it, key),
    })
  );
});

const sharingCreateSharedLinkWithSettingsMock = mock(
  (arg: { path: string }) => {
    const key = keyFromPath(arg.path);
    const it = store.get(key);
    if (!it) {
      return Promise.reject(
        responseError(409, {
          error: { ".tag": "path", path: { ".tag": "not_found" } },
          error_summary: "path/not_found/",
        })
      );
    }
    return Promise.resolve(
      wrapResult({
        ".tag": "file",
        id: it.id,
        name: it.name,
        url: `https://www.dropbox.com/scl/fi/${it.id}?dl=0`,
      })
    );
  }
);

const filesUploadSessionStartMock = mock(
  (_arg: { close: boolean; contents: Buffer }) =>
    Promise.resolve(wrapResult({ session_id: "session-1" }))
);
const filesUploadSessionAppendV2Mock = mock(
  (_arg: {
    close: boolean;
    contents: Buffer;
    cursor: { offset: number; session_id: string };
  }) => Promise.resolve(wrapResult({}))
);
const filesUploadSessionFinishMock = mock(
  (arg: {
    commit: { path: string; mode?: { ".tag": string }; mute?: boolean };
    contents: Buffer;
    cursor: { offset: number; session_id: string };
  }) => {
    const key = keyFromPath(arg.commit.path);
    const item = makeFile(key, Buffer.from(arg.contents));
    store.set(key, item);
    return Promise.resolve(wrapResult(fileMetadata(item, key)));
  }
);

const fakeAuth = {
  getAccessToken: () => "static-tok",
  setAccessToken: () => {},
};

const fakeClient = {
  auth: fakeAuth,
  filesCopyV2: filesCopyV2Mock,
  filesDeleteV2: filesDeleteV2Mock,
  filesDownload: filesDownloadMock,
  filesGetMetadata: filesGetMetadataMock,
  filesGetTemporaryLink: filesGetTemporaryLinkMock,
  filesListFolder: filesListFolderMock,
  filesListFolderContinue: filesListFolderContinueMock,
  filesUpload: filesUploadMock,
  filesUploadSessionAppendV2: filesUploadSessionAppendV2Mock,
  filesUploadSessionFinish: filesUploadSessionFinishMock,
  filesUploadSessionStart: filesUploadSessionStartMock,
  sharingCreateSharedLinkWithSettings: sharingCreateSharedLinkWithSettingsMock,
} as unknown as Dropbox;

const baseOpts = { client: fakeClient };

beforeEach(() => {
  store = new Map();
  nextId = 0;
  filesUploadMock.mockClear();
  filesDownloadMock.mockClear();
  filesGetMetadataMock.mockClear();
  filesDeleteV2Mock.mockClear();
  filesCopyV2Mock.mockClear();
  filesListFolderMock.mockClear();
  filesListFolderContinueMock.mockClear();
  filesGetTemporaryLinkMock.mockClear();
  sharingCreateSharedLinkWithSettingsMock.mockClear();
  filesUploadSessionStartMock.mockClear();
  filesUploadSessionAppendV2Mock.mockClear();
  filesUploadSessionFinishMock.mockClear();
});

afterEach(() => {
  // No-op — fetch is restored per-test where used.
});

describe("dropbox adapter", () => {
  test("missing auth throws at construction", () => {
    expect(() => dropbox({})).toThrow(/missing auth/iu);
  });

  test("accessToken + refreshToken throws at construction", () => {
    expect(() =>
      dropbox({ accessToken: "x", appKey: "a", refreshToken: "r" })
    ).toThrow(/exactly one/iu);
  });

  test("refreshToken without appKey throws at construction", () => {
    expect(() => dropbox({ refreshToken: "r" })).toThrow(
      /refreshToken.*appKey/iu
    );
  });

  test("upload writes content with the right path", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const result = await files.upload("docs/a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toMatch(/^rev-/u);
    expect(result.lastModified).toBe(STABLE_MODIFIED_MS);

    const [putCall] = filesUploadMock.mock.calls;
    expect(putCall?.[0]?.path).toBe("/docs/a.txt");
    expect(putCall?.[0]?.mode).toEqual({ ".tag": "overwrite" });
  });

  test("upload rejects metadata", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { metadata: { foo: "bar" } })
    ).rejects.toThrow(/metadata.*not supported/iu);
  });

  test("upload rejects cacheControl", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl.*not supported/iu);
  });

  test("upload with publicByDefault creates a shared link", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hello");
    expect(sharingCreateSharedLinkWithSettingsMock).toHaveBeenCalledTimes(1);
    const [arg] = sharingCreateSharedLinkWithSettingsMock.mock.calls;
    expect(arg?.[0]?.path).toBe("/a.txt");
  });

  test("upload accepts a ReadableStream and collects all chunks", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("part-1-"));
        controller.enqueue(enc.encode("part-2"));
        controller.close();
      },
    });
    const r = await files.upload("streamed.txt", stream);
    expect(r.size).toBe("part-1-part-2".length);
    const f = await files.download("streamed.txt");
    expect(await f.text()).toBe("part-1-part-2");
  });

  test("upload accepts an ArrayBuffer", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const ab = new TextEncoder().encode("ab-body").buffer as ArrayBuffer;
    const r = await files.upload("ab.bin", ab);
    expect(r.size).toBe("ab-body".length);
  });

  test("upload accepts a Blob and inherits its type", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const blob = new Blob(["blob-body"], { type: "application/x-test" });
    const r = await files.upload("blob.dat", blob);
    expect(r.contentType).toBe("application/x-test");
    expect(r.size).toBe("blob-body".length);
  });

  test("download returns bytes and metadata", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("hi");
    expect(f.lastModified).toBe(STABLE_MODIFIED_MS);
    expect(f.etag).toMatch(/^rev-/u);
    // content-type is inferred from filename, not stored
    expect(f.type).toBe("text/plain; charset=utf-8");
  });

  test("download (stream) fetches via temporary link", async () => {
    const originalFetch = globalThis.fetch;
    const enc = new TextEncoder();
    globalThis.fetch = ((_url: string | URL | Request) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("stream-bytes"));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as typeof fetch;
    try {
      const files = new Files({ adapter: dropbox(baseOpts) });
      await files.upload("a.txt", "stream-bytes");
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
      expect(total).toBe("stream-bytes".length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("head returns metadata with lazy body factory", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const f = await files.head("a.txt");
    expect(f.size).toBe(2);
    expect(f.etag).toMatch(/^rev-/u);
    expect(filesDownloadMock).not.toHaveBeenCalled();
    expect(await f.text()).toBe("hi");
    expect(filesDownloadMock).toHaveBeenCalledTimes(1);
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.exists("a.txt")).resolves.toBe(true);
    await expect(files.exists("ghost.txt")).resolves.toBe(false);
  });

  test("delete is idempotent on missing keys", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.delete("ghost.txt");
  });

  test("delete removes existing item", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    await files.delete("a.txt");
    await expect(files.head("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy duplicates the source file at the destination key", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("from.txt", "hi");
    await files.copy("from.txt", "to.txt");
    const head = await files.head("to.txt");
    expect(head.key).toBe("to.txt");
    expect(head.size).toBe(2);
  });

  test("list returns all files (recursive) and filters folders", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "x");
    await files.upload("nested/b.txt", "x");
    const r = await files.list();
    expect(r.items.map((i) => i.key).toSorted()).toEqual([
      "a.txt",
      "nested/b.txt",
    ]);
  });

  test("list applies prefix filter", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("alpha.txt", "x");
    await files.upload("beta.txt", "x");
    const r = await files.list({ prefix: "alp" });
    expect(r.items.map((i) => i.key)).toEqual(["alpha.txt"]);
  });

  test("list propagates has_more cursor", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesListFolderMock.mockImplementationOnce(() =>
      Promise.resolve(
        wrapResult({
          cursor: "page-2-cursor",
          entries: [],
          has_more: true,
        })
      )
    );
    const r = await files.list();
    expect(r.cursor).toBe("page-2-cursor");
  });

  test("list with cursor calls filesListFolderContinue", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.list({ cursor: "saved-cursor" });
    expect(filesListFolderContinueMock).toHaveBeenCalledTimes(1);
    expect(filesListFolderContinueMock.mock.calls[0]?.[0]?.cursor).toBe(
      "saved-cursor"
    );
  });

  test("url returns a 4-hour temporary link by default", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toMatch(/^https:\/\/content\.dropboxapi\.com\/tmp\//u);
  });

  test("url returns shared link when publicByDefault is true (rewritten dl=1)", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toContain("dl=1");
    expect(url).not.toContain("dl=0");
  });

  test("url returns publicBaseUrl-joined path when set", async () => {
    const files = new Files({
      adapter: dropbox({
        ...baseOpts,
        publicBaseUrl: "https://cdn.example.com/files",
      }),
    });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toBe("https://cdn.example.com/files/a.txt");
  });

  test("url throws on responseContentDisposition", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/u);
  });

  test("url throws when expiresIn exceeds 4-hour cap", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.url("a.txt", { expiresIn: 86_400 })).rejects.toThrow(
      /14400|4h|maximum/u
    );
  });

  test("signedUploadUrl throws", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 3600 })
    ).rejects.toThrow(/signedUploadUrl is not supported/iu);
  });

  test("rootFolderPath nests virtual keys under the configured folder", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, rootFolderPath: "/SDK Storage/" }),
    });
    await files.upload("a.txt", "hi");
    const [putCall] = filesUploadMock.mock.calls;
    expect(putCall?.[0]?.path).toBe("/SDK Storage/a.txt");
    // list() should still surface the un-prefixed virtual key
    const r = await files.list();
    expect(r.items.map((i) => i.key)).toEqual(["a.txt"]);
  });

  test.each([
    ["path/not_found/", "NotFound"],
    ["path_lookup/not_found/", "NotFound"],
    ["invalid_access_token/", "Unauthorized"],
    ["expired_access_token/", "Unauthorized"],
    ["missing_scope/required.scope/", "Unauthorized"],
    ["path/conflict/file/", "Conflict"],
    ["other/", "Provider"],
  ] as const)(
    "mapDropboxError classifies %s as %s",
    async (summary, expected) => {
      const files = new Files({ adapter: dropbox(baseOpts) });
      filesGetMetadataMock.mockImplementationOnce(() =>
        Promise.reject(
          responseError(409, {
            error: parseSummaryToErrorBody(summary),
            error_summary: summary,
          })
        )
      );
      const err = await files.head("a.txt").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(expected);
    }
  );

  test("mapDropboxError uses error_summary as message", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          error: { ".tag": "path", path: { ".tag": "not_found" } },
          error_summary: "path/not_found/the-file",
        })
      )
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).message).toBe("path/not_found/the-file");
  });

  test("mapDropboxError falls back to err.message when error_summary is absent", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          error: { ".tag": "path", path: { ".tag": "not_found" } },
          message: "fallback message text",
        })
      )
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).message).toBe("fallback message text");
  });

  test("mapDropboxError handles non-DropboxResponseError rejections with a status hint", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const err = Object.assign(new Error("boom"), { status: 404 });
    filesGetMetadataMock.mockImplementationOnce(() => Promise.reject(err));
    const result = await files.head("a.txt").catch((error: unknown) => error);
    expect(result).toBeInstanceOf(FilesError);
    expect((result as FilesError).code).toBe("NotFound");
    expect((result as FilesError).message).toBe("boom");
  });

  test.each([
    [401, "Unauthorized"],
    [403, "Unauthorized"],
    [412, "Conflict"],
  ] as const)(
    "mapDropboxError classifies plain status %s as %s",
    async (status, expected) => {
      const files = new Files({ adapter: dropbox(baseOpts) });
      const err = Object.assign(new Error(`http ${status}`), { status });
      filesGetMetadataMock.mockImplementationOnce(() => Promise.reject(err));
      const result = await files.head("a.txt").catch((error: unknown) => error);
      expect((result as FilesError).code).toBe(expected);
    }
  );

  test("mapDropboxError leaves a thrown FilesError unwrapped", async () => {
    // Stream-mode download throws a FilesError directly inside the try block
    // when the temporary-link fetch returns non-OK; that path runs through
    // mapDropboxError, which must pass it through untouched (same code,
    // same message, no double-wrapping).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(new Response("nope", { status: 502 }))) as typeof fetch;
    try {
      const files = new Files({ adapter: dropbox(baseOpts) });
      await files.upload("a.txt", "hi");
      const err = await files
        .download("a.txt", { as: "stream" })
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe("Provider");
      expect((err as FilesError).message).toMatch(
        /temporary-link fetch failed \(502\)/u
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("upload accepts a Uint8Array body", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const bytes = new TextEncoder().encode("u8-body");
    const r = await files.upload("u8.bin", bytes);
    expect(r.size).toBe("u8-body".length);
    expect(r.contentType).toBe("application/octet-stream");
    const f = await files.download("u8.bin");
    expect(await f.text()).toBe("u8-body");
  });

  test("upload accepts an ArrayBufferView (DataView) body", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    const ab = new TextEncoder().encode("dv-body").buffer as ArrayBuffer;
    const view = new DataView(ab);
    const r = await files.upload("dv.bin", view);
    expect(r.size).toBe("dv-body".length);
    expect(r.contentType).toBe("application/octet-stream");
  });

  test("download accepts ArrayBuffer-shaped fileBinary", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    const ab = new TextEncoder().encode("ab-bytes").buffer as ArrayBuffer;
    filesDownloadMock.mockImplementationOnce(() =>
      Promise.resolve(
        wrapResult({
          ...fileMetadata(makeFile("a.txt", Buffer.from("ab-bytes")), "a.txt"),
          fileBinary: ab,
        })
      )
    );
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("ab-bytes");
  });

  test("download accepts Blob-shaped fileBlob (browser/Workers shape)", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    const blob = new Blob(["blob-bytes"], { type: "application/x-test" });
    filesDownloadMock.mockImplementationOnce(() =>
      Promise.resolve(
        wrapResult({
          ...fileMetadata(
            makeFile("a.txt", Buffer.from("blob-bytes")),
            "a.txt"
          ),
          fileBlob: blob,
        })
      )
    );
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("blob-bytes");
  });

  test("download throws Provider when SDK returns neither fileBinary nor fileBlob", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("a.txt", "hi");
    filesDownloadMock.mockImplementationOnce(() =>
      Promise.resolve(
        wrapResult(fileMetadata(makeFile("a.txt", Buffer.from("hi")), "a.txt"))
      )
    );
    const err = await files.download("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
    expect((err as FilesError).message).toMatch(
      /unexpected download response shape/u
    );
  });

  test("download(stream) maps temporary-link fetch failure to Provider", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: string | URL | Request) =>
      Promise.resolve(
        new Response("server down", { status: 503 })
      )) as typeof fetch;
    try {
      const files = new Files({ adapter: dropbox(baseOpts) });
      await files.upload("a.txt", "hi");
      const err = await files
        .download("a.txt", { as: "stream" })
        .catch((error: unknown) => error);
      expect((err as FilesError).code).toBe("Provider");
      expect((err as FilesError).message).toMatch(
        /temporary-link fetch failed \(503\)/u
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("download infers application/octet-stream for files without extension", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    await files.upload("noext", "raw-bytes");
    const f = await files.download("noext");
    expect(f.type).toBe("application/octet-stream");
  });

  test("head throws NotFound when the entry is a folder", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    // The SDK union returns FolderMetadata for folders. Cast the off-shape
    // body — the adapter runtime-checks `.tag` and rejects non-file entries.
    filesGetMetadataMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({ ".tag": "folder", id: "folder-id", name: "subdir" })
      )) as never);
    const err = await files.head("subdir").catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("NotFound");
    expect((err as FilesError).message).toMatch(/not a file.*tag=folder/u);
  });

  test("head throws NotFound when the entry is deleted", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({ ".tag": "deleted", name: "gone.txt" })
      )) as never);
    const err = await files.head("gone.txt").catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("NotFound");
    expect((err as FilesError).message).toMatch(/not a file.*tag=deleted/u);
  });

  test("exists returns false when filesGetMetadata reports a folder", async () => {
    // exists() has its own copy of the folder/deleted guard (it can't reuse
    // head() because the probe wrapper expects NotFound, not a value).
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({ ".tag": "folder", id: "folder-id", name: "subdir" })
      )) as never);
    await expect(files.exists("subdir")).resolves.toBe(false);
  });

  test("exists returns false when filesGetMetadata reports a deleted entry", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({ ".tag": "deleted", name: "gone.txt" })
      )) as never);
    await expect(files.exists("gone.txt")).resolves.toBe(false);
  });

  test("delete throws non-NotFound errors instead of swallowing them", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesDeleteV2Mock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          error: { ".tag": "path_lookup", path_lookup: { ".tag": "other" } },
          error_summary: "path_lookup/other/",
        })
      )
    );
    const err = await files.delete("x.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
  });

  test("copy maps SDK errors to FilesError", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesCopyV2Mock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(401, {
          error: { ".tag": "invalid_access_token" },
          error_summary: "invalid_access_token/",
        })
      )
    );
    const err = await files
      .copy("a.txt", "b.txt")
      .catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("Unauthorized");
  });

  test("upload maps SDK errors to FilesError", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesUploadMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(401, {
          error: { ".tag": "expired_access_token" },
          error_summary: "expired_access_token/",
        })
      )
    );
    const err = await files
      .upload("a.txt", "hi")
      .catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("Unauthorized");
  });

  test("list maps SDK errors to FilesError", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesListFolderMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(401, {
          error: { ".tag": "missing_scope" },
          error_summary: "missing_scope/files.metadata.read",
        })
      )
    );
    const err = await files.list().catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("Unauthorized");
  });

  test("url maps SDK errors to FilesError", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetTemporaryLinkMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          error: { ".tag": "path", path: { ".tag": "not_found" } },
          error_summary: "path/not_found/",
        })
      )
    );
    const err = await files.url("ghost.txt").catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("NotFound");
  });

  test("publicByDefault leaves dl=1 URLs unchanged", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    // Two calls happen: one during upload, one during url(). Both should
    // return the dl=1 URL unchanged. The minimal `{ url }` shape is
    // sufficient for the adapter; cast around the SDK's stricter type.
    const dl1Result = (() =>
      Promise.resolve(
        wrapResult({
          ".tag": "file",
          url: "https://www.dropbox.com/scl/fi/x?dl=1",
        })
      )) as never;
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce(dl1Result);
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce(dl1Result);
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toBe("https://www.dropbox.com/scl/fi/x?dl=1");
  });

  test("publicByDefault appends dl=1 when the URL has no dl param", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    // First call (during upload) — no query string at all
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({ ".tag": "file", url: "https://www.dropbox.com/scl/fi/x" })
      )) as never);
    // Second call (during url()) — existing query string, no dl=
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({
          ".tag": "file",
          url: "https://www.dropbox.com/scl/fi/y?token=abc",
        })
      )) as never);
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toBe("https://www.dropbox.com/scl/fi/y?token=abc&dl=1");
  });

  test("publicByDefault recovers from shared_link_already_exists by reusing the existing URL", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    // The Dropbox SDK exposes the failed-variant body directly at
    // err.error (no outer { error, error_summary } wrap), so the recovery
    // branch can read shared_link_already_exists.metadata.url off it.
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          ".tag": "shared_link_already_exists",
          shared_link_already_exists: {
            metadata: {
              url: "https://www.dropbox.com/scl/fi/existing?dl=0",
            },
          },
        })
      )
    );
    const url = await files.url("a.txt");
    expect(url).toBe("https://www.dropbox.com/scl/fi/existing?dl=1");
  });

  test("publicByDefault rethrows shared_link errors that don't carry an existing URL", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(403, {
          error: { ".tag": "access_denied" },
          error_summary: "access_denied/team_policy_disallows_public_links/",
        })
      )
    );
    const err = await files.url("a.txt").catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("Unauthorized");
  });

  test("publicByDefault rethrows shared_link_already_exists when no existing URL is embedded", async () => {
    // The "already exists" recovery only fires when the embedded metadata
    // actually carries a usable url — empty/missing url falls through to
    // the outer throw rather than synthesizing a bogus link.
    const files = new Files({
      adapter: dropbox({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    sharingCreateSharedLinkWithSettingsMock.mockImplementationOnce(() =>
      Promise.reject(
        responseError(409, {
          ".tag": "shared_link_already_exists",
          shared_link_already_exists: { metadata: { url: "" } },
        })
      )
    );
    const err = await files.url("a.txt").catch((error: unknown) => error);
    expect((err as FilesError).code).toBe("Conflict");
  });

  test("list filters out the root folder entry when its path equals rootFolderPath", async () => {
    const files = new Files({
      adapter: dropbox({ ...baseOpts, rootFolderPath: "rootDir" }),
    });
    filesListFolderMock.mockImplementationOnce(() =>
      Promise.resolve(
        wrapResult({
          cursor: "",
          entries: [
            {
              ".tag": "file",
              client_modified: STABLE_MODIFIED,
              id: "id:0",
              name: "rootDir",
              path_display: "/rootDir",
              path_lower: "/rootdir",
              rev: "rev-0",
              server_modified: STABLE_MODIFIED,
              size: 0,
            },
          ],
          has_more: false,
        })
      )
    );
    const r = await files.list();
    expect(r.items).toEqual([]);
  });

  test("list skips folder entries", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesListFolderMock.mockImplementationOnce((() =>
      Promise.resolve(
        wrapResult({
          cursor: "",
          entries: [
            { ".tag": "folder", id: "fid", name: "sub", path_display: "/sub" },
            {
              ".tag": "file",
              client_modified: STABLE_MODIFIED,
              id: "id:1",
              name: "a.txt",
              path_display: "/a.txt",
              path_lower: "/a.txt",
              rev: "rev-1",
              server_modified: STABLE_MODIFIED,
              size: 2,
            },
          ],
          has_more: false,
        })
      )) as never);
    const r = await files.list();
    expect(r.items.map((i) => i.key)).toEqual(["a.txt"]);
  });

  test("mapDropboxError tolerates deeply nested error bodies (depth guard)", async () => {
    // Build a body nested ~8 levels deep — past the recursion guard. The
    // classifier should still complete without blowing the stack and
    // gracefully fall back to Provider since no recognized tag is reachable
    // before the depth limit kicks in.
    interface DeepNode {
      nested?: DeepNode;
      ".tag"?: string;
    }
    const body: DeepNode = {};
    let cur = body;
    for (let i = 0; i < 8; i += 1) {
      cur.nested = { ".tag": `level-${i}` };
      cur = cur.nested;
    }
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce(() =>
      Promise.reject(responseError(500, body))
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
  });

  test("mapDropboxError tolerates non-object error bodies", async () => {
    // Defensive: the DropboxResponseError contract takes any value as the
    // body. errorSummary should bail out cleanly on null without throwing.
    const files = new Files({ adapter: dropbox(baseOpts) });
    filesGetMetadataMock.mockImplementationOnce(() =>
      Promise.reject(responseError(500, null))
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
    expect((err as FilesError).message).toBe("Dropbox error");
  });

  test("upload uses the chunked session API for files larger than 150MB", async () => {
    const files = new Files({ adapter: dropbox(baseOpts) });
    // 150 MiB + 1 byte — just over the simple-upload threshold.
    const SIZE = 150 * 1024 * 1024 + 1;
    const big = Buffer.allocUnsafe(SIZE);
    const r = await files.upload("big.bin", big);
    expect(r.size).toBe(SIZE);
    expect(filesUploadMock).not.toHaveBeenCalled();
    expect(filesUploadSessionStartMock).toHaveBeenCalledTimes(1);
    expect(filesUploadSessionFinishMock).toHaveBeenCalledTimes(1);
    // Chunk size is 8 MiB. After the start (chunk 0) we append until the
    // remaining tail is <= 8 MiB. For 150MiB+1: append at offsets 8..136
    // inclusive (17 calls), then finish handles the 6MiB+1 tail at offset 144.
    expect(filesUploadSessionAppendV2Mock).toHaveBeenCalledTimes(17);
    const finishArg = filesUploadSessionFinishMock.mock.calls[0]?.[0];
    expect(finishArg?.cursor.session_id).toBe("session-1");
    expect(finishArg?.cursor.offset).toBe(144 * 1024 * 1024);
    expect(finishArg?.commit.path).toBe("/big.bin");
    // The append cursor offsets must monotonically advance by 8 MiB.
    const offsets = filesUploadSessionAppendV2Mock.mock.calls.map(
      (c) => (c[0] as { cursor: { offset: number } }).cursor.offset
    );
    expect(offsets[0]).toBe(8 * 1024 * 1024);
    expect(offsets.at(-1)).toBe(136 * 1024 * 1024);
    for (let i = 1; i < offsets.length; i += 1) {
      expect((offsets[i] ?? 0) - (offsets[i - 1] ?? 0)).toBe(8 * 1024 * 1024);
    }
  });
});
