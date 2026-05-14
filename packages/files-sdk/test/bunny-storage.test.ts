import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files } from "../src/index.js";

interface StoredEntry {
  bytes: Uint8Array;
  contentType: string;
  checksum: string | null;
  lastChanged: Date;
}

const backing = new Map<string, StoredEntry>();

const stripPath = (path: string): string => path.replace(/^\/+/u, "");

const bytesFromStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

let checksumCounter = 0;
const nextChecksum = () => {
  checksumCounter += 1;
  return `checksum-${checksumCounter}`;
};

const makeStorageFile = (
  key: string,
  entry: StoredEntry,
  isDirectory = false
) => {
  const normalizedKey = isDirectory ? key.replace(/\/+$/u, "") : key;
  const idx = normalizedKey.lastIndexOf("/");
  const objectName = idx === -1 ? normalizedKey : normalizedKey.slice(idx + 1);
  const path = isDirectory ? `/${normalizedKey}/` : `/${normalizedKey}`;
  return {
    _tag: "StorageFile" as const,
    checksum: entry.checksum,
    contentType: entry.contentType,
    data: () =>
      Promise.resolve({
        length: entry.bytes.byteLength,
        response: new Response(entry.bytes as BodyInit),
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
      }),
    dateCreated: entry.lastChanged,
    guid: `guid-${key}`,
    isDirectory,
    lastChanged: entry.lastChanged,
    length: entry.bytes.byteLength,
    objectName,
    path,
    replicatedZones: null,
    serverId: 1,
    storageZoneId: 1,
    storageZoneName: "uploads",
    userId: "user-1",
  };
};

const connectWithAccessKeyMock = mock(
  (region: string, name: string, accessKey: string) => ({
    _tag: "StorageZone" as const,
    accessKey,
    name,
    region,
  })
);

const getMock = mock((storageZone: unknown, path: string) => {
  const key = stripPath(path);
  const entry = backing.get(key);
  if (!entry) {
    return Promise.reject(new Error(`File not found: ${path}`));
  }
  return Promise.resolve(makeStorageFile(key, entry));
});

const listMock = mock((_storageZone: unknown, path: string) => {
  const directory = stripPath(path).replace(/\/+$/u, "");
  const prefix = directory ? `${directory}/` : "";
  const directories = new Set<string>();
  const entries: ReturnType<typeof makeStorageFile>[] = [];
  for (const [key, entry] of backing.entries()) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const childPath = key.slice(prefix.length);
    const childDirectoryIndex = childPath.indexOf("/");
    if (childDirectoryIndex === -1) {
      entries.push(makeStorageFile(key, entry));
      continue;
    }
    const directoryKey = `${prefix}${childPath.slice(0, childDirectoryIndex)}/`;
    if (!directories.has(directoryKey)) {
      directories.add(directoryKey);
      entries.push(
        makeStorageFile(
          directoryKey,
          {
            bytes: new Uint8Array(),
            checksum: null,
            contentType: "",
            lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          },
          true
        )
      );
    }
  }
  return Promise.resolve(entries);
});

const removeMock = mock((_storageZone: unknown, path: string) =>
  Promise.resolve(backing.delete(stripPath(path)))
);

const uploadMock = mock(
  async (
    _storageZone: unknown,
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: { contentType?: string }
  ) => {
    const bytes = await bytesFromStream(stream);
    backing.set(stripPath(path), {
      bytes,
      checksum: nextChecksum(),
      contentType: options?.contentType ?? "application/octet-stream",
      lastChanged: new Date("2024-01-01T00:00:00.000Z"),
    });
    return true;
  }
);

mock.module("@bunny.net/storage-sdk", () => ({
  file: {
    get: getMock,
    list: listMock,
    remove: removeMock,
    upload: uploadMock,
  },
  regions: {
    StorageRegion: {
      Falkenstein: "de",
      Johannesburg: "jh",
      London: "uk",
      LosAngeles: "la",
      NewYork: "ny",
      SaoPaulo: "br",
      Singapore: "sg",
      Stockholm: "se",
      Sydney: "syd",
    },
  },
  zone: {
    connect_with_accesskey: connectWithAccessKeyMock,
    name: (storageZone: { name: string }) => storageZone.name,
  },
}));

const { bunnyStorage } = await import("../src/bunny-storage/index.js");

beforeEach(() => {
  backing.clear();
  checksumCounter = 0;
  connectWithAccessKeyMock.mockClear();
  getMock.mockClear();
  listMock.mockClear();
  removeMock.mockClear();
  uploadMock.mockClear();
  delete process.env.BUNNY_STORAGE_ZONE;
  delete process.env.BUNNY_STORAGE_ACCESS_KEY;
  delete process.env.BUNNY_ACCESS_KEY;
  delete process.env.BUNNY_STORAGE_REGION;
  delete process.env.STORAGE_ZONE;
  delete process.env.STORAGE_ACCESS_KEY;
  delete process.env.STORAGE_REGION;
});

afterEach(() => {
  backing.clear();
});

describe("bunnyStorage adapter", () => {
  test("missing credentials throw at construction", () => {
    expect(() => bunnyStorage()).toThrow(/missing credentials/u);
  });

  test("constructs from env fallbacks", () => {
    process.env.BUNNY_STORAGE_ZONE = "uploads";
    process.env.BUNNY_STORAGE_ACCESS_KEY = "key";
    process.env.BUNNY_STORAGE_REGION = "de";
    const adapter = bunnyStorage();
    expect(adapter.name).toBe("bunny-storage");
    expect(adapter.zone).toBe("uploads");
    expect(connectWithAccessKeyMock).toHaveBeenCalledWith(
      "de",
      "uploads",
      "key"
    );
  });

  test("rejects unsupported regions", () => {
    expect(() =>
      bunnyStorage({
        accessKey: "key",
        region: "mars" as never,
        zone: "uploads",
      })
    ).toThrow(/unsupported region/u);
  });

  test("upload writes through the Bunny SDK without a metadata round-trip", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    const result = await files.upload("docs/a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result).toEqual({
      contentType: "text/plain",
      key: "docs/a.txt",
      size: 5,
    });
    expect(result.etag).toBeUndefined();
    expect(result.lastModified).toBeUndefined();
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
    expect(uploadMock.mock.calls[0]?.[1]).toBe("/docs/a.txt");
    expect(uploadMock.mock.calls[0]?.[3]).toEqual({
      contentType: "text/plain",
    });
  });

  test("upload rejects unsupported cacheControl and metadata", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(
      files.upload("a.txt", "hi", { cacheControl: "max-age=60" })
    ).rejects.toMatchObject({ code: "Provider" });
    await expect(
      files.upload("a.txt", "hi", { metadata: { owner: "me" } })
    ).rejects.toMatchObject({ code: "Provider" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test("download, stream download, head, and exists expose StoredFile fields", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });

    const downloaded = await files.download("a.txt");
    expect(await downloaded.text()).toBe("hello");
    expect(downloaded.type).toBe("text/plain");
    expect(downloaded.etag).toBe("checksum-1");

    const streamed = await files.download("a.txt", { as: "stream" });
    expect(await new Response(streamed.stream()).text()).toBe("hello");

    const headed = await files.head("a.txt");
    expect(headed.size).toBe(5);
    expect(await headed.text()).toBe("hello");
    await expect(files.exists("a.txt")).resolves.toBe(true);
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("list supports prefix, limit, and numeric cursor over Bunny directory listings", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("docs/a.txt", "a");
    await files.upload("docs/b.txt", "b");
    await files.upload("images/c.txt", "c");

    const first = await files.list({ limit: 1, prefix: "docs/" });
    expect(first.items.map((item) => item.key)).toEqual(["docs/a.txt"]);
    expect(first.cursor).toBe("1");

    const second = await files.list({
      cursor: first.cursor,
      limit: 1,
      prefix: "docs/",
    });
    expect(second.items.map((item) => item.key)).toEqual(["docs/b.txt"]);
    expect(second.cursor).toBeUndefined();
  });

  test("list only returns immediate files from Bunny directory listings", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("docs/2024/a.txt", "a");

    const result = await files.list({ prefix: "docs/" });

    expect(result.items.map((item) => item.key)).toEqual([]);
    expect(listMock.mock.calls.at(-1)?.[1]).toBe("/docs/");
  });

  test("copy is read-then-write", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });
    await files.copy("a.txt", "b.txt");
    const copied = await files.download("b.txt");
    expect(await copied.text()).toBe("hello");
    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  test("delete delegates to remove and is idempotent", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("a.txt", "hello");
    getMock.mockClear();
    await files.delete("a.txt");
    await files.delete("a.txt");
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(getMock).not.toHaveBeenCalled();
    await expect(files.download("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("url requires publicBaseUrl and rejects content-disposition overrides", async () => {
    const privateFiles = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(privateFiles.url("a.txt")).rejects.toMatchObject({
      code: "Provider",
    });

    const publicFiles = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        publicBaseUrl: "https://cdn.example.com/uploads/",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(publicFiles.url("a.txt")).resolves.toBe(
      "https://cdn.example.com/uploads/a.txt"
    );
    await expect(
      publicFiles.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("signedUploadUrl throws", async () => {
    const adapter = bunnyStorage({
      accessKey: "key",
      region: "de",
      zone: "uploads",
    });
    const files = new Files({ adapter });
    await expect(
      adapter.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({ code: "Provider" });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({ code: "Provider" });
  });
});
