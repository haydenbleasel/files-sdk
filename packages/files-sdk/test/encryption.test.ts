import { describe, expect, test } from "bun:test";

import { encryption, generateEncryptionKey } from "../src/encryption/index.js";
import { createStoredFile, Files } from "../src/index.js";
import type {
  Adapter,
  ConditionalFilesOperation,
  FilesOperation,
  PluginNext,
} from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const encrypted = async (adapter = fakeAdapter()): Promise<Files> =>
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
    expect(typed.type).toBe("text/markdown");

    // A string with no declared type keeps the inferred default.
    await files.upload("inferred", "hello");
    const inferred = await files.head("inferred");
    expect(inferred.type).toBe("text/plain; charset=utf-8");
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
        etag: "etag-2",
        key: "secret.txt",
        metadata: latest.metadata,
        size: latest.body.byteLength,
        type: latest.type,
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
    const adapter: Adapter = { ...fakeAdapter(), supportsMetadata: false };
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
    const { downloaded } = await files.download(["a", "b"]);
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
