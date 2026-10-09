import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import { cache } from "../src/cache/index.js";
import { encryption, generateEncryptionKey } from "../src/encryption/index.js";
import { failover } from "../src/failover/index.js";
import {
  createFiles,
  createStoredFile,
  Files,
  FilesError,
  UploadControl,
} from "../src/index.js";
import type {
  Adapter,
  ConditionalFilesOperation,
  FileEvent,
  FilesOperation,
  PluginNext,
} from "../src/index.js";
import { FOLD_PROVIDER_EVENT } from "../src/internal/events.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";

const encrypted = async (adapter: Adapter = fakeAdapter()): Promise<Files> =>
  new Files({ adapter, plugins: [encryption(await generateEncryptionKey())] });

describe("encryption plugin — round-trips", () => {
  test("upload + download round-trips a string", async () => {
    const files = await encrypted();
    const result = await files.upload("a.txt", "hello");
    expect(result.size).toBe(5);
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
    expect(file.size).toBe(5);
  });

  test("stores ciphertext + envelope metadata at rest", async () => {
    const adapter = fakeAdapter();
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await files.upload("a.txt", "hello");

    // Read the raw stored object through a plugin-free instance.
    const raw = await new Files({ adapter }).download("a.txt");
    // ciphertext = plaintext (5) + GCM tag (16).
    expect(raw.size).toBe(5 + 16);
    expect(raw.metadata?.fsenc_scheme).toBe("aes-gcm/envelope/v1");
    expect(raw.metadata?.fsenc_iv).toBeDefined();
    expect(raw.metadata?.fsenc_dek).toBeDefined();
    expect(await raw.text()).not.toBe("hello");
  });

  test("round-trips binary, ArrayBuffer, and stream bodies", async () => {
    const files = await encrypted();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    await files.upload("bin", bytes);
    const bin = await files.download("bin");
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(bytes);

    await files.upload("buf", bytes.buffer);
    const buf = await files.download("buf");
    expect(buf.size).toBe(5);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    await files.upload("str", stream);
    const str = await files.download("str");
    expect(await str.text()).toBe("streamed");
  });

  test("preserves the content type through encryption", async () => {
    const files = await encrypted();
    await files.upload("typed", "hello", { contentType: "text/markdown" });
    const typed = await files.head("typed");
    expect(typed.contentType).toBe("text/markdown");

    // A string with no declared type keeps the inferred default.
    await files.upload("inferred", "hello");
    const inferred = await files.head("inferred");
    expect(inferred.contentType).toBe("text/plain; charset=utf-8");
  });
});

describe("encryption plugin — conditional pipeline", () => {
  test("encrypts create and replace, then decrypts an exact read", async () => {
    const plugin = encryption(await generateEncryptionKey());
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("encryption wrap missing");
    }
    const stored: {
      body: Uint8Array;
      metadata: Record<string, string>;
      type: string;
    }[] = [];
    const uploadNext = ((candidate: FilesOperation) => {
      if (candidate.kind !== "upload") {
        throw new Error("expected upload");
      }
      if (!(candidate.body instanceof Uint8Array)) {
        throw new Error("expected buffered ciphertext");
      }
      const metadata = candidate.options?.metadata;
      if (!metadata) {
        throw new Error("expected encryption metadata");
      }
      stored.push({
        body: candidate.body,
        metadata,
        type: candidate.options?.contentType ?? "application/octet-stream",
      });
      return Promise.resolve({
        contentType:
          candidate.options?.contentType ?? "application/octet-stream",
        etag: `etag-${stored.length}`,
        key: candidate.key,
        size: candidate.body.byteLength,
      });
    }) as PluginNext;
    const createOperation: Extract<
      ConditionalFilesOperation,
      { kind: "upload"; mode: "create" }
    > = {
      body: "created secret",
      key: "secret.txt",
      kind: "upload",
      mode: "create",
    };
    const replaceOperation: Extract<
      ConditionalFilesOperation,
      { kind: "upload"; mode: "replace" }
    > = {
      body: "replaced secret",
      etag: "etag-1",
      key: "secret.txt",
      kind: "upload",
      mode: "replace",
    };

    await wrap(createOperation, uploadNext);
    const replaced = await wrap(replaceOperation, uploadNext);

    expect(stored).toHaveLength(2);
    for (const [index, record] of stored.entries()) {
      const plaintext = index === 0 ? "created secret" : "replaced secret";
      expect(new TextDecoder().decode(record.body)).not.toBe(plaintext);
      expect(record.metadata.fsenc_scheme).toBe("aes-gcm/envelope/v1");
      expect(record.metadata.fsenc_iv).toBeDefined();
      expect(record.metadata.fsenc_dek).toBeDefined();
    }
    expect(replaced.size).toBe("replaced secret".length);

    const [, latest] = stored;
    if (!latest) {
      throw new Error("expected replaced ciphertext");
    }
    const raw = createStoredFile(
      {
        contentType: latest.type,
        etag: "etag-2",
        key: "secret.txt",
        metadata: latest.metadata,
        size: latest.body.byteLength,
      },
      { data: latest.body, kind: "buffer" }
    );
    const exactOperation: Extract<
      ConditionalFilesOperation,
      { kind: "download" }
    > = {
      etag: "etag-2",
      key: "secret.txt",
      kind: "download",
      mode: "exact",
    };
    const exact = await wrap(exactOperation, (() =>
      Promise.resolve(raw)) as PluginNext);

    expect(await exact.text()).toBe("replaced secret");
    expect(exact.metadata).toBeUndefined();
  });

  test("vetoes a ranged exact read before the provider pipeline", async () => {
    const plugin = encryption(await generateEncryptionKey());
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("encryption wrap missing");
    }
    let nextCalls = 0;
    const next = (() => {
      nextCalls += 1;
      return Promise.resolve();
    }) as PluginNext;
    const operation: Extract<ConditionalFilesOperation, { kind: "download" }> =
      {
        etag: "etag-1",
        key: "secret.txt",
        kind: "download",
        mode: "exact",
        options: { range: { end: 3, start: 0 } },
      };

    await expect(wrap(operation, next)).rejects.toThrow(/range downloads/u);
    expect(nextCalls).toBe(0);
  });
});

describe("encryption plugin — metadata", () => {
  test("preserves user metadata and strips internal fields on read", async () => {
    const files = await encrypted();

    await files.upload("withmeta", "x", { metadata: { owner: "alice" } });
    const withMeta = await files.download("withmeta");
    expect(withMeta.metadata).toEqual({ owner: "alice" });

    await files.upload("nometa", "y");
    const noMeta = await files.download("nometa");
    expect(noMeta.metadata).toBeUndefined();
  });

  test("head reports plaintext size and hides internal metadata", async () => {
    const files = await encrypted();
    await files.upload("a.txt", "hello", { metadata: { owner: "bob" } });
    const meta = await files.head("a.txt");
    expect(meta.size).toBe(5);
    expect(meta.metadata).toEqual({ owner: "bob" });
  });

  test("list corrects encrypted items and passes plaintext through", async () => {
    const adapter = fakeAdapter();
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await files.upload("enc.txt", "secret");
    // A sibling object written without the plugin.
    await new Files({ adapter }).upload("plain.txt", "open");

    const { items } = await files.list();
    const enc = items.find((item) => item.key === "enc.txt");
    const plain = items.find((item) => item.key === "plain.txt");
    expect(enc?.size).toBe(6);
    expect(enc?.metadata).toBeUndefined();
    expect(plain?.size).toBe(4);

    // head on a plaintext object also passes straight through.
    const head = await files.head("plain.txt");
    expect(head.size).toBe(4);
  });
});

describe("encryption plugin — head and list metadata", () => {
  test("head() and list() return plain metadata with no body accessors", async () => {
    const files = await encrypted();
    await files.upload("a.txt", "hello", { metadata: { owner: "bob" } });
    const head = await files.head("a.txt");
    expect(Object.keys(head).toSorted()).toEqual([
      "contentType",
      "etag",
      "key",
      "lastModified",
      "metadata",
      "size",
    ]);
    expect(head).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      key: "a.txt",
      metadata: { owner: "bob" },
      size: 5,
    });
    const { items } = await files.list();
    expect(items).toEqual([head]);
    // Reading the plaintext is an explicit download.
    const downloaded = await files.download("a.txt");
    expect(await downloaded.text()).toBe("hello");
  });

  test("list() items with no metadata pass through at their stored size", async () => {
    // S3 and the S3-compatibles return no metadata from list(), so there's no
    // envelope marker to spot: the item reports the stored (ciphertext) size,
    // and a download still decrypts.
    const inner = fakeAdapter();
    const adapter: Adapter = {
      ...inner,
      async list(opts) {
        const page = await inner.list(opts);
        return {
          ...page,
          items: page.items.map(({ metadata: _metadata, ...file }) => file),
        };
      },
    };
    const files = await encrypted(adapter);
    await files.upload("enc.txt", "secret");
    const { items } = await files.list();
    const [enc] = items;
    expect(enc?.metadata).toBeUndefined();
    expect(enc?.size).toBeGreaterThan("secret".length);
    const downloaded = await files.download("enc.txt");
    expect(await downloaded.text()).toBe("secret");
  });

  test("head() reports the declared size without decrypting", async () => {
    const adapter = fakeAdapter();
    const writer = await encrypted(adapter);
    await writer.upload("a.txt", "hello");
    // A different key can't decrypt, but head never tries to.
    const other = await encrypted(adapter);
    const head = await other.head("a.txt");
    expect(head.size).toBe(5);
    await expect(other.download("a.txt")).rejects.toThrow(/failed to decrypt/u);
  });

  test("a cache() head hit and miss report the same plaintext metadata", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [cache(), encryption(await generateEncryptionKey())],
    });
    await files.upload("a.txt", "hello", { metadata: { owner: "bob" } });
    const miss = await files.head("a.txt");
    const hit = await files.head("a.txt");
    expect(files.cacheStats()).toEqual({ hits: 1, misses: 1 });
    expect(miss.size).toBe(5);
    expect(miss.metadata).toEqual({ owner: "bob" });
    expect(hit).toEqual(miss);
  });
});

// A signing-capable adapter: without the plugin's capabilities hook, the
// gateway would redirect downloads to a url() the plugin refuses.
const signing = (): Adapter =>
  withCapabilities(memory(), {
    signedUrl: { maxExpiresIn: 3600, supported: true },
  });

describe("encryption plugin — resumable uploads", () => {
  test("a control upload is refused before any I/O", async () => {
    const adapter = memory();
    const files = await encrypted(adapter);
    const control = new UploadControl();
    const failure = await files
      .upload("a.txt", "hello", { control })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "Unsupported", permanent: true });
    expect((failure as Error).message).toMatch(
      /resumable uploads are not supported by the "encryption" plugin/u
    );
    expect(control.status).toBe("idle");
    expect(await new Files({ adapter }).exists("a.txt")).toBe(false);
  });

  test("advertises no resumable uploads; multipart without control still works", async () => {
    const adapter = memory();
    expect(new Files({ adapter }).capabilities.resumable).toBe(true);
    const files = await encrypted(adapter);
    expect(files.capabilities.resumable).toBe(false);
    await files.upload("a.txt", "hello", { multipart: true });
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
  });
});

describe("encryption plugin — capabilities + gateway", () => {
  test("advertises no presigned URLs and no range reads", async () => {
    const files = await encrypted(signing());
    expect(files.capabilities.signedUrl).toEqual({
      disposition: false,
      expiry: "none",
      supported: false,
    });
    expect(files.capabilities.rangeRead).toBe(false);
    expect(files.capabilities.metadata).toBe(true);
  });

  test("the gateway proxies downloads through the plugin instead of failing", async () => {
    const files = await encrypted(signing());
    await files.upload("a.txt", "hello gateway");
    const endpoint = "https://app.test/api/files?op=download&key=a.txt";
    const gateway = (onUnsupportedRange?: "ignore" | "reject") =>
      createFilesRouter({
        files,
        operations: ["download"],
        secret: "test-secret",
        ...(onUnsupportedRange && { onUnsupportedRange }),
      });

    const full = await gateway().handle(new Request(endpoint));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("13");
    expect(await full.text()).toBe("hello gateway");

    // A Range header gets the non-range-adapter treatment, never a 500.
    const rangeHeaders = { headers: { range: "bytes=0-4" } };
    const rejected = await gateway().handle(
      new Request(endpoint, rangeHeaders)
    );
    expect(rejected.status).toBe(416);
    const ignored = await gateway("ignore").handle(
      new Request(endpoint, rangeHeaders)
    );
    expect(ignored.status).toBe(200);
    expect(await ignored.text()).toBe("hello gateway");
  });
});

describe("encryption plugin — passthrough + failure", () => {
  test("download passes through objects written without the plugin", async () => {
    const adapter = fakeAdapter();
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await new Files({ adapter }).upload("plain.txt", "hello");
    const file = await files.download("plain.txt");
    expect(await file.text()).toBe("hello");
  });

  test("download with the wrong key rejects", async () => {
    const adapter = fakeAdapter();
    const writer = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await writer.upload("a.txt", "hello");

    const other = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await expect(other.download("a.txt")).rejects.toThrow(/failed to decrypt/u);
  });

  test("a forged fsenc_size is detected at download time", async () => {
    // GCM authenticates the body and the wrapped DEK; `fsenc_size` is the one
    // envelope field plain metadata tampering can forge. head()/list() can't
    // verify it (they never decrypt), but a download must.
    const adapter = fakeAdapter();
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await files.upload("a.txt", "hello");

    // Tamper with the stored metadata directly against the provider.
    const raw = new Files({ adapter });
    const stored = await raw.download("a.txt");
    await raw.upload("a.txt", new Uint8Array(await stored.arrayBuffer()), {
      contentType: stored.type,
      metadata: { ...stored.metadata, fsenc_size: "9999" },
    });

    await expect(files.download("a.txt")).rejects.toThrow(
      /metadata has been tampered with/u
    );
  });
});

describe("encryption plugin — refused operations", () => {
  test("range downloads, url(), and signedUploadUrl() throw", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsRange: true }),
      plugins: [encryption(await generateEncryptionKey())],
    });
    await files.upload("a.txt", "hello");
    await expect(
      files.download("a.txt", { range: { end: 3, start: 0 } })
    ).rejects.toThrow(/range downloads/u);
    await expect(files.url("a.txt")).rejects.toThrow(/url\(\)/u);
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/signedUploadUrl/u);
  });

  test("upload throws on an adapter without metadata support", async () => {
    const adapter: Adapter = withCapabilities(fakeAdapter(), {
      metadata: false,
    });
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await expect(files.upload("a.txt", "hello")).rejects.toThrow(
      /`metadata` is not supported/u
    );
  });
});

describe("encryption plugin — keys", () => {
  test("accepts raw Uint8Array and ArrayBuffer keys", async () => {
    const a = new Files({
      adapter: fakeAdapter(),
      plugins: [encryption(crypto.getRandomValues(new Uint8Array(32)))],
    });
    await a.upload("k", "hi");
    const af = await a.download("k");
    expect(await af.text()).toBe("hi");

    const b = new Files({
      adapter: fakeAdapter(),
      plugins: [encryption(crypto.getRandomValues(new Uint8Array(32)).buffer)],
    });
    await b.upload("k", "yo");
    const bf = await b.download("k");
    expect(await bf.text()).toBe("yo");
  });

  test("rejects a raw key of the wrong length", async () => {
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [encryption(new Uint8Array(10))],
    });
    await expect(files.upload("k", "x")).rejects.toThrow(
      /16, 24, or 32 bytes/u
    );
  });

  test("generateEncryptionKey produces a usable CryptoKey", async () => {
    const key = await generateEncryptionKey();
    expect(key).toBeInstanceOf(CryptoKey);
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [encryption(key)],
    });
    await files.upload("a.txt", "hello");
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
  });
});

describe("encryption plugin — bulk + copy", () => {
  test("encrypts every item of a bulk upload and decrypts in bulk", async () => {
    const files = await encrypted();
    await files.upload([
      { body: "one", key: "a" },
      { body: "two", key: "b" },
    ]);
    const { results: downloaded } = await files.download(["a", "b"]);
    const texts = await Promise.all(downloaded.map((file) => file.text()));
    expect(texts).toEqual(["one", "two"]);
  });

  test("copy preserves the envelope so the copy still decrypts", async () => {
    const files = await encrypted();
    await files.upload("a.txt", "hello");
    await files.copy("a.txt", "b.txt");
    const file = await files.download("b.txt");
    expect(await file.text()).toBe("hello");
  });
});

/** A `next` that fails the test if a plugin calls through. */
const unreachable = (): Promise<never> => {
  throw new Error("next must not run");
};

describe("encryption plugin — backstop refusals", () => {
  // The core refuses `range` and `control` before any plugin runs, because the
  // plugin narrows those capabilities. The plugin still refuses them itself,
  // for an outer plugin that injects one into the op it passes inward.
  test("refuses an injected range or control without calling next", async () => {
    const plugin = encryption(await generateEncryptionKey());
    const wrap = plugin.wrap as NonNullable<typeof plugin.wrap>;
    await expect(
      wrap(
        { key: "a.txt", kind: "download", options: { range: { start: 0 } } },
        unreachable
      )
    ).rejects.toThrow(
      /encryption: range downloads are unsupported on encrypted objects/u
    );
    await expect(
      wrap(
        {
          body: "x",
          key: "a.txt",
          kind: "upload",
          options: { control: new UploadControl() },
        },
        unreachable
      )
    ).rejects.toThrow(
      /encryption: resumable uploads \(`control`\) are unsupported/u
    );
  });
});

describe("encryption plugin — refusals are permanent", () => {
  test("an outer failover() doesn't re-send a refused call to a plugin-less secondary", async () => {
    // Range-capable like the primary: failover() advertises only what every
    // backend can do, and this checks the plugin's own refusal.
    const secondary = fakeAdapter({ supportsRange: true });
    await new Files({ adapter: secondary }).upload("a.txt", "replica");
    const files = new Files({
      // Range-capable, so the range refusal is the plugin's, not the adapter's.
      adapter: fakeAdapter({ supportsRange: true }),
      plugins: [
        failover({ secondaries: secondary }),
        encryption(await generateEncryptionKey()),
      ],
    });
    await files.upload("a.txt", "hello");
    const refusals = [
      () => files.url("a.txt"),
      () => files.signedUploadUrl("a.txt", { expiresIn: 60 }),
      () => files.download("a.txt", { range: { end: 1, start: 0 } }),
    ];
    for (const refused of refusals) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is inspected on its own
      const failure = await refused().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as FilesError).message).toMatch(/encryption/u);
    }
  });

  test("decryption and envelope failures are permanent", async () => {
    const adapter = fakeAdapter();
    const writer = await encrypted(adapter);
    await writer.upload("a.txt", "hello");
    const wrongKey = await encrypted(adapter);
    const failed = await wrongKey
      .download("a.txt")
      .catch((error: unknown) => error);
    expect((failed as FilesError).permanent).toBe(true);

    const key = await generateEncryptionKey();
    await new Files({ adapter, plugins: [encryption(key)] }).upload(
      "b.txt",
      "hello"
    );
    const entry = adapter.raw.get("b.txt");
    if (entry?.metadata) {
      entry.metadata.fsenc_size = "4";
    }
    const tampered = await new Files({ adapter, plugins: [encryption(key)] })
      .download("b.txt")
      .catch((error: unknown) => error);
    expect((tampered as FilesError).message).toMatch(/tampered/u);
    expect((tampered as FilesError).permanent).toBe(true);

    expect(() => encryption(new Uint8Array(7))).not.toThrow();
    const badKey = await new Files({
      adapter,
      plugins: [encryption(new Uint8Array(7))],
    })
      .upload("c.txt", "x")
      .catch((error: unknown) => error);
    expect((badKey as FilesError).permanent).toBe(true);
  });
});

/** A provider event as `files-sdk/events` hands it to the core. */
const providerEvent = (key: string): FileEvent => ({
  etag: '"stored"',
  id: key,
  key,
  provider: "fake",
  raw: null,
  size: 99,
  source: "provider",
  time: 0,
  type: "created",
});

describe("encryption plugin — provider events", () => {
  test("clears the stored (ciphertext) size on every event, keeping the ETag", async () => {
    // The event carries no metadata, so an object encryption() didn't write
    // can't be told apart: its size is cleared as well.
    const { size: _size, ...rest } = providerEvent("a.txt");
    const files = await encrypted();
    expect(files[FOLD_PROVIDER_EVENT](providerEvent("a.txt"))).toEqual(rest);
  });
});
