import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

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

const MOCK_ZONE = "uploads";

const makeStorageFile = (
  key: string,
  entry: StoredEntry,
  isDirectory = false
) => {
  // Mirror real Bunny semantics:
  //   Path        = "/<StorageZoneName>/<parent-dir>/"   (always trailing /)
  //   ObjectName  = "<filename>" or "<dirname>"           (no slashes)
  const trimmed = key.replace(/\/+$/u, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const objectName = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
  const parentDir = lastSlash === -1 ? "" : trimmed.slice(0, lastSlash);
  const path = parentDir ? `/${MOCK_ZONE}/${parentDir}/` : `/${MOCK_ZONE}/`;
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
    storageZoneName: MOCK_ZONE,
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

const { bunnyStorage, mapBunnyStorageError } =
  await import("../src/bunny-storage/index.js");

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

  test("upload writes through the Bunny SDK and rounds-trips metadata", async () => {
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
      etag: "checksum-1",
      key: "docs/a.txt",
      lastModified: new Date("2024-01-01T00:00:00.000Z").getTime(),
      size: 5,
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]?.[1]).toBe("/docs/a.txt");
    expect(uploadMock.mock.calls[0]?.[3]).toEqual({
      contentType: "text/plain",
    });
    expect(getMock.mock.calls[0]?.[1]).toBe("/docs/a.txt");
  });

  test("upload falls back to local metadata when the head round-trip fails", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    // Force the post-upload `get()` to reject without affecting the upload
    // itself. The adapter should still return a sensible UploadResult.
    const realGet = (_storageZone: unknown, path: string) => {
      const key = stripPath(path);
      const entry = backing.get(key);
      if (!entry) {
        return Promise.reject(new Error(`File not found: ${path}`));
      }
      return Promise.resolve(makeStorageFile(key, entry));
    };
    let getCalls = 0;
    getMock.mockImplementation((zone: unknown, path: string) => {
      getCalls += 1;
      if (getCalls === 1) {
        return Promise.reject(new Error("transient network blip"));
      }
      return realGet(zone, path);
    });
    try {
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
    } finally {
      getMock.mockImplementation(realGet);
    }
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

  test("constructs from STORAGE_* aliases used in the Bunny SDK README", () => {
    process.env.STORAGE_ZONE = "uploads";
    process.env.STORAGE_ACCESS_KEY = "key";
    process.env.STORAGE_REGION = "de";
    const adapter = bunnyStorage();
    expect(adapter.zone).toBe("uploads");
    expect(connectWithAccessKeyMock).toHaveBeenCalledWith(
      "de",
      "uploads",
      "key"
    );
  });

  test("BUNNY_ACCESS_KEY is accepted as an alias", () => {
    process.env.BUNNY_STORAGE_ZONE = "uploads";
    process.env.BUNNY_ACCESS_KEY = "key";
    process.env.BUNNY_STORAGE_REGION = "de";
    bunnyStorage();
    expect(connectWithAccessKeyMock).toHaveBeenCalledWith(
      "de",
      "uploads",
      "key"
    );
  });

  test("explicit options override env vars", () => {
    process.env.BUNNY_STORAGE_ZONE = "from-env";
    process.env.BUNNY_STORAGE_ACCESS_KEY = "env-key";
    process.env.BUNNY_STORAGE_REGION = "ny";
    bunnyStorage({
      accessKey: "explicit-key",
      region: "de",
      zone: "explicit-zone",
    });
    expect(connectWithAccessKeyMock).toHaveBeenCalledWith(
      "de",
      "explicit-zone",
      "explicit-key"
    );
  });

  test("client option bypasses zone/accessKey/region resolution", () => {
    const customClient = {
      _tag: "StorageZone",
      accessKey: "from-client",
      name: "custom-zone",
      region: "ny",
    } as never;
    const adapter = bunnyStorage({
      client: customClient,
    });
    expect(adapter.zone).toBe("custom-zone");
    expect(adapter.raw).toBe(customClient);
    expect(connectWithAccessKeyMock).not.toHaveBeenCalled();
  });

  test("upload accepts a Uint8Array body", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    const bytes = new TextEncoder().encode("binary-payload");
    const result = await files.upload("bin.dat", bytes);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.contentType).toBe("application/octet-stream");
    expect(uploadMock.mock.calls[0]?.[3]).toEqual({
      contentType: "application/octet-stream",
    });
  });

  test("upload accepts an ArrayBuffer body", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    const ab = new TextEncoder().encode("from-arraybuffer").buffer;
    const result = await files.upload("ab.dat", ab);
    expect(result.size).toBe(ab.byteLength);
  });

  test("upload accepts a Blob and inherits its content type", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    const blob = new Blob(["from-blob"], { type: "text/markdown" });
    const result = await files.upload("note.md", blob);
    expect(result.contentType).toBe("text/markdown");
    expect(result.size).toBe(blob.size);
  });

  test("upload accepts a ReadableStream of unknown length, head fills the final size", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    const payload = new TextEncoder().encode("streamed-payload");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const result = await files.upload("stream.dat", stream);
    expect(result.size).toBe(payload.byteLength);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test("upload accepts an empty metadata object", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(
      files.upload("a.txt", "hi", { metadata: {} })
    ).resolves.toMatchObject({ key: "a.txt" });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  test("download maps a missing key to NotFound", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(files.download("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("head maps a missing key to NotFound", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(files.head("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy maps a missing source to NotFound", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(files.copy("missing.txt", "dest.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test("copy preserves the source content type", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("a.bin", "payload", { contentType: "image/png" });
    uploadMock.mockClear();
    await files.copy("a.bin", "b.bin");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0]?.[3]).toEqual({ contentType: "image/png" });
  });

  test("url URL-encodes special characters in the key", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        publicBaseUrl: "https://cdn.example.com/uploads/",
        region: "de",
        zone: "uploads",
      }),
    });
    await expect(files.url("folder name/file (1).png")).resolves.toBe(
      "https://cdn.example.com/uploads/folder%20name/file%20(1).png"
    );
  });

  test("list with no prefix lists the storage zone root", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("top.txt", "x");
    await files.upload("docs/nested.txt", "y");
    listMock.mockClear();
    const result = await files.list();
    expect(listMock.mock.calls.at(-1)?.[1]).toBe("/");
    expect(result.items.map((item) => item.key)).toEqual(["top.txt"]);
  });

  test("list with a prefix that doesn't end in slash falls back to the parent directory", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("docs/alpha.txt", "a");
    await files.upload("docs/beta.txt", "b");
    listMock.mockClear();
    const result = await files.list({ prefix: "docs/al" });
    expect(listMock.mock.calls.at(-1)?.[1]).toBe("/docs");
    expect(result.items.map((item) => item.key)).toEqual(["docs/alpha.txt"]);
  });

  test("list returns no items when prefix matches nothing", async () => {
    const files = new Files({
      adapter: bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      }),
    });
    await files.upload("docs/a.txt", "a");
    const result = await files.list({ prefix: "videos/" });
    expect(result.items).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  test("mapBunnyStorageError classifies the SDK's Unauthorized message", () => {
    const mapped = mapBunnyStorageError(
      new Error("Unauthorized access to storage zone: uploads")
    );
    expect(mapped.code).toBe("Unauthorized");
    expect(mapped.cause).toBeInstanceOf(Error);
  });

  test("mapBunnyStorageError passes FilesError through unchanged", () => {
    const original = new FilesError("Conflict", "already exists");
    const mapped = mapBunnyStorageError(original);
    expect(mapped).toBe(original);
  });

  test("adapter exposes name, zone, and raw client", () => {
    const adapter = bunnyStorage({
      accessKey: "key",
      region: "de",
      zone: "uploads",
    });
    expect(adapter.name).toBe("bunny-storage");
    expect(adapter.zone).toBe("uploads");
    expect(adapter.raw).toMatchObject({
      _tag: "StorageZone",
      name: "uploads",
      region: "de",
    });
  });

  test("head returns just the object name when the SDK reports an empty path", async () => {
    // The Bunny API can return `Path: "/"` for files at the storage-zone
    // root; after stripping the leading slash, `path` is empty and
    // `keyFromStorageFile` should fall back to `objectName`.
    const realGet = getMock.getMockImplementation();
    getMock.mockImplementation(() =>
      Promise.resolve({
        _tag: "StorageFile" as const,
        checksum: "etag-root",
        contentType: "text/plain",
        data: () =>
          Promise.resolve({
            length: 3,
            response: new Response("hey"),
            stream: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("hey"));
                controller.close();
              },
            }),
          }),
        dateCreated: new Date("2024-01-01T00:00:00.000Z"),
        guid: "g",
        isDirectory: false,
        lastChanged: new Date("2024-01-01T00:00:00.000Z"),
        length: 3,
        objectName: "root.txt",
        path: "/",
        replicatedZones: null,
        serverId: 1,
        storageZoneId: 1,
        storageZoneName: "uploads",
        userId: "u",
      })
    );
    try {
      const adapter = bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      });
      const stored = await adapter.head("root.txt");
      expect(stored.key).toBe("root.txt");
    } finally {
      if (realGet) {
        getMock.mockImplementation(realGet);
      }
    }
  });

  test("list strips the storage-zone prefix from Bunny's Path field", async () => {
    // Bunny's real listing API returns each entry with `Path: "/<zone>/<dir>/"`
    // (zone-prefixed, trailing slash) and `ObjectName: "file.txt"`. The
    // adapter strips the zone segment so the key returned to callers is
    // relative to the storage zone.
    const realList = listMock.getMockImplementation();
    listMock.mockImplementation(() =>
      Promise.resolve([
        {
          _tag: "StorageFile" as const,
          checksum: "etag-nested",
          contentType: "text/plain",
          data: () => Promise.reject(new Error("body not exercised")),
          dateCreated: new Date("2024-01-01T00:00:00.000Z"),
          guid: "g1",
          isDirectory: false,
          lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          length: 4,
          objectName: "file.txt",
          path: "/uploads/docs/",
          replicatedZones: null,
          serverId: 1,
          storageZoneId: 1,
          storageZoneName: "uploads",
          userId: "u",
        },
        {
          _tag: "StorageFile" as const,
          checksum: "etag-root",
          contentType: "text/plain",
          data: () => Promise.reject(new Error("body not exercised")),
          dateCreated: new Date("2024-01-01T00:00:00.000Z"),
          guid: "g2",
          isDirectory: false,
          lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          length: 2,
          objectName: "root.txt",
          path: "/uploads/",
          replicatedZones: null,
          serverId: 1,
          storageZoneId: 1,
          storageZoneName: "uploads",
          userId: "u",
        },
      ])
    );
    try {
      const adapter = bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      });
      const result = await adapter.list();
      expect(result.items.map((item) => item.key)).toEqual([
        "docs/file.txt",
        "root.txt",
      ]);
    } finally {
      if (realList) {
        listMock.mockImplementation(realList);
      }
    }
  });

  test("keyFromStorageFile clears the directory when Path equals the zone with no trailing slash", async () => {
    // Defensive: real Bunny always returns `Path: "/<zone>/"` with a
    // trailing slash, but if it ever omitted the slash we should still
    // treat the entry as living at the zone root.
    const realList = listMock.getMockImplementation();
    listMock.mockImplementation(() =>
      Promise.resolve([
        {
          _tag: "StorageFile" as const,
          checksum: "etag-zone-no-slash",
          contentType: "text/plain",
          data: () => Promise.reject(new Error("body not exercised")),
          dateCreated: new Date("2024-01-01T00:00:00.000Z"),
          guid: "g4",
          isDirectory: false,
          lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          length: 2,
          objectName: "loose.txt",
          path: "/uploads",
          replicatedZones: null,
          serverId: 1,
          storageZoneId: 1,
          storageZoneName: "uploads",
          userId: "u",
        },
      ])
    );
    try {
      const adapter = bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      });
      const result = await adapter.list();
      expect(result.items.map((item) => item.key)).toEqual(["loose.txt"]);
    } finally {
      if (realList) {
        listMock.mockImplementation(realList);
      }
    }
  });

  test("keyFromStorageFile returns the directory when ObjectName is missing", async () => {
    // Defensive: if Bunny ever returned an entry with an empty
    // `ObjectName` (e.g. a directory marker), fall back to the directory
    // portion of the key rather than producing an empty string.
    const realList = listMock.getMockImplementation();
    listMock.mockImplementation(() =>
      Promise.resolve([
        {
          _tag: "StorageFile" as const,
          checksum: null,
          contentType: "",
          data: () => Promise.reject(new Error("body not exercised")),
          dateCreated: new Date("2024-01-01T00:00:00.000Z"),
          guid: "g5",
          isDirectory: false,
          lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          length: 0,
          objectName: "",
          path: "/uploads/docs/",
          replicatedZones: null,
          serverId: 1,
          storageZoneId: 1,
          storageZoneName: "uploads",
          userId: "u",
        },
      ])
    );
    try {
      const adapter = bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      });
      const result = await adapter.list();
      expect(result.items.map((item) => item.key)).toEqual(["docs"]);
    } finally {
      if (realList) {
        listMock.mockImplementation(realList);
      }
    }
  });

  test("keyFromStorageFile tolerates a Path that already contains the object name", async () => {
    // Defensive coverage for the `directory.endsWith('/' + name)` branch:
    // if a Bunny endpoint ever returns `Path` as `/<zone>/<dir>/<name>`
    // (i.e. the full key) the adapter must not duplicate `ObjectName` on
    // the end.
    const realList = listMock.getMockImplementation();
    listMock.mockImplementation(() =>
      Promise.resolve([
        {
          _tag: "StorageFile" as const,
          checksum: "etag-fullpath",
          contentType: "text/plain",
          data: () => Promise.reject(new Error("body not exercised")),
          dateCreated: new Date("2024-01-01T00:00:00.000Z"),
          guid: "g3",
          isDirectory: false,
          lastChanged: new Date("2024-01-01T00:00:00.000Z"),
          length: 4,
          objectName: "file.txt",
          path: "/uploads/docs/file.txt",
          replicatedZones: null,
          serverId: 1,
          storageZoneId: 1,
          storageZoneName: "uploads",
          userId: "u",
        },
      ])
    );
    try {
      const adapter = bunnyStorage({
        accessKey: "key",
        region: "de",
        zone: "uploads",
      });
      const result = await adapter.list();
      expect(result.items.map((item) => item.key)).toEqual(["docs/file.txt"]);
    } finally {
      if (realList) {
        listMock.mockImplementation(realList);
      }
    }
  });

  test("mapBunnyStorageError reads `code` directly when the source error exposes one", () => {
    const mapped = mapBunnyStorageError({
      code: "NotFound",
      message: "object missing",
    });
    expect(mapped.code).toBe("NotFound");
    expect(mapped.message).toBe("object missing");
  });

  test("mapBunnyStorageError handles non-object errors via the optional-chain short-circuit", () => {
    // Exercises the `e?.code` / `e?.message` short-circuit branch when the
    // thrown value isn't an object (the SDK should never do this, but it's
    // cheap to harden the extractor).
    const fromString = mapBunnyStorageError("plain string error");
    expect(fromString).toBeInstanceOf(FilesError);
    expect(fromString.code).toBe("Provider");
    const fromNull = mapBunnyStorageError(null);
    expect(fromNull.code).toBe("Provider");
  });

  test("mapBunnyStorageError classifies conflict/precondition messages as Conflict", () => {
    const fromConflict = mapBunnyStorageError(new Error("Conflict on write"));
    expect(fromConflict.code).toBe("Conflict");
    const fromPrecondition = mapBunnyStorageError(
      new Error("Precondition failed")
    );
    expect(fromPrecondition.code).toBe("Conflict");
  });

  test("delete wraps SDK-thrown errors in a FilesError", async () => {
    const realRemove = removeMock.getMockImplementation();
    removeMock.mockImplementation(() =>
      Promise.reject(new Error("Unauthorized access to storage zone: uploads"))
    );
    try {
      const files = new Files({
        adapter: bunnyStorage({
          accessKey: "key",
          region: "de",
          zone: "uploads",
        }),
      });
      const promise = files.delete("a.txt");
      await expect(promise).rejects.toBeInstanceOf(FilesError);
      await expect(promise).rejects.toMatchObject({ code: "Unauthorized" });
    } finally {
      if (realRemove) {
        removeMock.mockImplementation(realRemove);
      }
    }
  });

  test("list wraps SDK-thrown errors in a FilesError", async () => {
    const realList = listMock.getMockImplementation();
    listMock.mockImplementation(() =>
      Promise.reject(new Error("Unauthorized access to storage zone: uploads"))
    );
    try {
      const files = new Files({
        adapter: bunnyStorage({
          accessKey: "key",
          region: "de",
          zone: "uploads",
        }),
      });
      const promise = files.list();
      await expect(promise).rejects.toBeInstanceOf(FilesError);
      await expect(promise).rejects.toMatchObject({ code: "Unauthorized" });
    } finally {
      if (realList) {
        listMock.mockImplementation(realList);
      }
    }
  });
});
