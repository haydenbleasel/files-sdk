import { describe, expect, test } from "bun:test";

import { AwsClient } from "aws4fetch";

import { FilesError } from "../src/index.js";
import { s3FetchAdapter } from "../src/internal/s3-fetch.js";
import type { S3FetchAdapterOptions } from "../src/internal/s3-fetch.js";
import { makeFakeS3 } from "./fake-s3-server.js";

const makeAdapter = (
  overrides: Partial<S3FetchAdapterOptions> = {}
): ReturnType<typeof s3FetchAdapter> =>
  s3FetchAdapter({
    accessKeyId: "AKID",
    bucket: "uploads",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    forcePathStyle: true,
    region: "auto",
    secretAccessKey: "SECRET",
    ...overrides,
  });

const withFake = (overrides: Partial<S3FetchAdapterOptions> = {}) => {
  const fake = makeFakeS3();
  const adapter = makeAdapter({ fetch: fake.fetchImpl, ...overrides });
  return { adapter, fake };
};

const erroringBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("body broke"));
    },
  });

const expectCode = async (
  operation: Promise<unknown>,
  code: FilesError["code"]
): Promise<FilesError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(FilesError);
    expect((error as FilesError).code).toBe(code);
    return error as FilesError;
  }
  throw new Error(`expected a FilesError with code ${code}`);
};

describe("s3-fetch core — identity", () => {
  test("defaults: name, raw AwsClient, bucket", () => {
    const adapter = makeAdapter();
    expect(adapter.name).toBe("s3-fetch");
    expect(adapter.raw).toBeInstanceOf(AwsClient);
    expect(adapter.bucket).toBe("uploads");
  });

  test("name override and capability flags", () => {
    const adapter = makeAdapter({ name: "r2-http-fetch" });
    expect(adapter.name).toBe("r2-http-fetch");
    expect(adapter.supportsRange).toBe(true);
    expect(adapter.supportsDelimiter).toBe(true);
    expect(adapter.supportsMetadata).toBe(true);
    expect(adapter.supportsCacheControl).toBe(true);
    expect(adapter.supportsServerSideCopy).toBe(true);
    expect(adapter.signedUrl).toEqual({ supported: true });
    expect(adapter.resumableUpload).toBeUndefined();
    expect(adapter.deleteMany).toBeUndefined();
    expect(adapter.reportsUploadProgress).toBeUndefined();
  });
});

describe("s3-fetch core — upload", () => {
  test("uploads a string with SigV4 headers and returns etag/size", async () => {
    const { adapter, fake } = withFake();
    const result = await adapter.upload("notes/hello.txt", "hello world");
    expect(result.key).toBe("notes/hello.txt");
    expect(result.size).toBe(11);
    expect(result.contentType).toBe("text/plain; charset=utf-8");
    expect(result.etag).toBe("etag-1");
    const put = fake.requests[0] as Request;
    expect(put.method).toBe("PUT");
    expect(new URL(put.url).pathname).toBe("/uploads/notes/hello.txt");
    expect(put.headers.get("authorization")).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKID/"
    );
    // Streaming-friendly signing: the payload is never hashed.
    expect(put.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  });

  test("uploads metadata and cacheControl as headers", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("a.bin", new Uint8Array([1, 2, 3]), {
      cacheControl: "public, max-age=60",
      contentType: "application/x-thing",
      metadata: { owner: "hayden" },
    });
    const stored = fake.store.get("a.bin");
    expect(stored?.type).toBe("application/x-thing");
    expect(stored?.cacheControl).toBe("public, max-age=60");
    expect(stored?.meta).toEqual({ owner: "hayden" });
  });

  test("buffers Blob and ReadableStream bodies into a single PUT", async () => {
    const { adapter } = withFake();
    const blob = new Blob(["from-blob"], { type: "text/x-blob" });
    const blobResult = await adapter.upload("blob.txt", blob);
    expect(blobResult.size).toBe(9);
    expect(blobResult.contentType).toBe("text/x-blob");
    const stream = new Blob(["from-a-stream"]).stream();
    const streamResult = await adapter.upload("stream.txt", stream);
    expect(streamResult.size).toBe(13);
    const roundTrip = await adapter.download("stream.txt");
    expect(await roundTrip.text()).toBe("from-a-stream");
  });

  test("multipart uploads fail loudly with a permanent error", async () => {
    const { adapter } = withFake();
    const error = await expectCode(
      adapter.upload("big.bin", "x", { multipart: true }),
      "Provider"
    );
    expect(error.message).toMatch(/multipart uploads are not supported/u);
    expect(error.permanent).toBe(true);
  });

  test("upload surfaces provider errors mapped by status", async () => {
    const { adapter, fake } = withFake();
    fake.denyAll = true;
    const error = await expectCode(
      adapter.upload("a.txt", "nope"),
      "Unauthorized"
    );
    expect(error.message).toBe("Access Denied");
  });
});

describe("s3-fetch core — download/head/exists/delete", () => {
  test("download returns bytes and header-derived metadata", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("doc.txt", "content here", {
      contentType: "text/markdown",
      metadata: { kind: "doc" },
    });
    const file = await adapter.download("doc.txt");
    expect(await file.text()).toBe("content here");
    expect(file.size).toBe(12);
    expect(file.type).toBe("text/markdown");
    expect(file.etag).toBe("etag-1");
    expect(file.metadata).toEqual({ kind: "doc" });
    expect(typeof file.lastModified).toBe("number");
    expect(fake.requests.at(-1)?.method).toBe("GET");
  });

  test("download as stream yields the raw body stream", async () => {
    const { adapter } = withFake();
    await adapter.upload("s.txt", "streamed");
    const file = await adapter.download("s.txt", { as: "stream" });
    const stream = file.stream();
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await new Response(stream).text()).toBe("streamed");
  });

  test("download honors byte ranges via the Range header", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("r.txt", "0123456789");
    const slice = await adapter.download("r.txt", {
      range: { end: 5, start: 2 },
    });
    expect(await slice.text()).toBe("2345");
    expect(slice.size).toBe(4);
    expect(fake.requests.at(-1)?.headers.get("range")).toBe("bytes=2-5");
    const openEnded = await adapter.download("r.txt", { range: { start: 7 } });
    expect(await openEnded.text()).toBe("789");
  });

  test("download of a missing key maps NoSuchKey to NotFound", async () => {
    const { adapter } = withFake();
    const error = await expectCode(adapter.download("ghost.txt"), "NotFound");
    expect(error.message).toBe("No such key");
  });

  test("head returns metadata without a body transfer, with a lazy GET body", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("h.txt", "head me", { metadata: { a: "b" } });
    const before = fake.requests.length;
    const file = await adapter.head("h.txt");
    expect(file.size).toBe(7);
    expect(file.metadata).toEqual({ a: "b" });
    expect(fake.requests.length).toBe(before + 1);
    expect(fake.requests.at(-1)?.method).toBe("HEAD");
    // The body accessors lazily issue a signed GET.
    expect(await file.text()).toBe("head me");
    expect(fake.requests.at(-1)?.method).toBe("GET");
  });

  test("head of a missing key throws NotFound from the status alone", async () => {
    const { adapter } = withFake();
    await expectCode(adapter.head("ghost.txt"), "NotFound");
  });

  test("exists returns true/false and rethrows non-NotFound errors", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("e.txt", "x");
    expect(await adapter.exists("e.txt")).toBe(true);
    expect(await adapter.exists("ghost.txt")).toBe(false);
    fake.denyAll = true;
    await expectCode(adapter.exists("e.txt"), "Unauthorized");
  });

  test("delete removes the object and is idempotent", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("d.txt", "bye");
    await adapter.delete("d.txt");
    expect(fake.store.has("d.txt")).toBe(false);
    await adapter.delete("d.txt");
    fake.denyAll = true;
    await expectCode(adapter.delete("d.txt"), "Unauthorized");
  });
});

describe("s3-fetch core — copy", () => {
  test("copies server-side with an encoded x-amz-copy-source", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("src dir/from.txt", "copy me", {
      contentType: "text/x-src",
    });
    await adapter.copy("src dir/from.txt", "dst/to.txt");
    expect(fake.store.get("dst/to.txt")?.type).toBe("text/x-src");
    const copyRequest = fake.requests.at(-1) as Request;
    expect(copyRequest.headers.get("x-amz-copy-source")).toBe(
      "/uploads/src%20dir/from.txt"
    );
    const copied = await adapter.download("dst/to.txt");
    expect(await copied.text()).toBe("copy me");
  });

  test("copy of a missing source throws NotFound", async () => {
    const { adapter } = withFake();
    await expectCode(adapter.copy("ghost.txt", "dst.txt"), "NotFound");
  });

  test("copy detects the 200-with-<Error>-body failure mode", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("from.txt", "x");
    fake.failNextCopyWith200 = true;
    const error = await expectCode(
      adapter.copy("from.txt", "to.txt"),
      "Provider"
    );
    expect(error.message).toBe("Copy failed mid-flight");
  });
});

describe("s3-fetch core — list", () => {
  test("lists with prefix, XML-decoded keys, etag, size, lastModified", async () => {
    const { adapter } = withFake();
    await adapter.upload("logs/a&b <1>.txt", "1234");
    await adapter.upload("logs/plain.txt", "56");
    await adapter.upload("other/skip.txt", "x");
    const result = await adapter.list({ prefix: "logs/" });
    expect(result.items.map((item) => item.key)).toEqual([
      "logs/a&b <1>.txt",
      "logs/plain.txt",
    ]);
    const [first] = result.items;
    expect(first?.size).toBe(4);
    expect(first?.etag).toBe("etag-1");
    expect(typeof first?.lastModified).toBe("number");
    expect(result.cursor).toBeUndefined();
    expect(result.prefixes).toBeUndefined();
  });

  test("list items expose a lazy body", async () => {
    const { adapter } = withFake();
    await adapter.upload("lazy.txt", "lazy body");
    const { items } = await adapter.list();
    expect(await items[0]?.text()).toBe("lazy body");
  });

  test("paginates via continuation tokens", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("p/1.txt", "a");
    await adapter.upload("p/2.txt", "b");
    await adapter.upload("p/3.txt", "c");
    const page1 = await adapter.list({ limit: 2, prefix: "p/" });
    expect(page1.items).toHaveLength(2);
    expect(page1.cursor).toBe("p/2.txt");
    const listRequest = new URL((fake.requests.at(-1) as Request).url);
    expect(listRequest.searchParams.get("max-keys")).toBe("2");
    expect(listRequest.searchParams.get("list-type")).toBe("2");
    const page2 = await adapter.list({
      cursor: page1.cursor as string,
      limit: 2,
      prefix: "p/",
    });
    expect(page2.items.map((item) => item.key)).toEqual(["p/3.txt"]);
    expect(page2.cursor).toBeUndefined();
  });

  test("delimiter folds nested keys into common prefixes", async () => {
    const { adapter, fake } = withFake();
    await adapter.upload("photos/cover.jpg", "x");
    await adapter.upload("photos/2023/a.jpg", "x");
    await adapter.upload("photos/2024/b.jpg", "x");
    const result = await adapter.list({ delimiter: "/", prefix: "photos/" });
    expect(result.items.map((item) => item.key)).toEqual(["photos/cover.jpg"]);
    expect(result.prefixes).toEqual(["photos/2023/", "photos/2024/"]);
    const listRequest = new URL((fake.requests.at(-1) as Request).url);
    expect(listRequest.searchParams.get("delimiter")).toBe("/");
  });

  test("parses numeric entities, skips key-less blocks, defaults missing fields", async () => {
    const xml = [
      `<?xml version="1.0"?><ListBucketResult>`,
      "<IsTruncated>true</IsTruncated>",
      "<NextContinuationToken>tok&amp;1</NextContinuationToken>",
      "<Contents><Key>caf&#233;/&#x41;.txt</Key><Size>7</Size>",
      `<ETag>&quot;abc&quot;</ETag>`,
      "<LastModified>2024-01-02T03:04:05.000Z</LastModified></Contents>",
      "<Contents><Size>9</Size></Contents>",
      "<Contents><Key>bare.txt</Key></Contents>",
      "</ListBucketResult>",
    ].join("");
    const adapter = makeAdapter({
      fetch: () => Promise.resolve(new Response(xml, { status: 200 })),
    });
    const result = await adapter.list();
    expect(result.items.map((item) => item.key)).toEqual([
      "café/A.txt",
      "bare.txt",
    ]);
    expect(result.items[0]?.etag).toBe("abc");
    expect(result.items[0]?.lastModified).toBe(
      Date.parse("2024-01-02T03:04:05.000Z")
    );
    expect(result.items[1]?.size).toBe(0);
    expect(result.items[1]?.etag).toBeUndefined();
    expect(result.cursor).toBe("tok&1");
  });

  test("list surfaces provider errors", async () => {
    const { adapter, fake } = withFake();
    fake.denyAll = true;
    await expectCode(adapter.list(), "Unauthorized");
  });
});

describe("s3-fetch core — url and signedUploadUrl", () => {
  test("url presigns a GET with the default expiry", async () => {
    const adapter = makeAdapter();
    const url = new URL(await adapter.url("docs/report pdf.pdf"));
    expect(url.hostname).toBe("acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/uploads/docs/report%20pdf.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(url.searchParams.get("X-Amz-Credential")).toStartWith("AKID/");
  });

  test("url honors expiresIn, defaultUrlExpiresIn, and disposition", async () => {
    const adapter = makeAdapter({ defaultUrlExpiresIn: 120 });
    const byDefault = new URL(await adapter.url("a.txt"));
    expect(byDefault.searchParams.get("X-Amz-Expires")).toBe("120");
    const custom = new URL(
      await adapter.url("a.txt", {
        expiresIn: 60,
        responseContentDisposition: "attachment",
      })
    );
    expect(custom.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(custom.searchParams.get("response-content-disposition")).toBe(
      "attachment"
    );
  });

  test("publicBaseUrl short-circuits url() unless disposition forces signing", async () => {
    const adapter = makeAdapter({ publicBaseUrl: "https://cdn.example.com/" });
    expect(await adapter.url("img/pic 1.png")).toBe(
      "https://cdn.example.com/img/pic%201.png"
    );
    const signed = await adapter.url("img/pic 1.png", {
      responseContentDisposition: "attachment",
    });
    expect(signed).toContain("X-Amz-Signature=");
  });

  test("virtual-hosted addressing puts the bucket in the hostname", async () => {
    const adapter = s3FetchAdapter({
      accessKeyId: "AKID",
      bucket: "media",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      secretAccessKey: "SECRET",
    });
    const url = new URL(await adapter.url("a.txt"));
    expect(url.hostname).toBe("media.s3.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/a.txt");
  });

  test("sessionToken rides along as X-Amz-Security-Token", async () => {
    const adapter = makeAdapter({ sessionToken: "TOKEN" });
    const url = new URL(await adapter.url("a.txt"));
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("TOKEN");
  });

  test("signedUploadUrl presigns a PUT and binds contentType into the signature", async () => {
    const adapter = makeAdapter();
    const upload = await adapter.signedUploadUrl("in/new file.bin", {
      contentType: "image/png",
      expiresIn: 90,
    });
    expect(upload.method).toBe("PUT");
    if (upload.method !== "PUT") {
      throw new Error("expected a PUT upload");
    }
    expect(upload.headers).toEqual({ "Content-Type": "image/png" });
    const url = new URL(upload.url);
    expect(url.pathname).toBe("/uploads/in/new%20file.bin");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("90");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type"
    );
  });

  test("signedUploadUrl without contentType leaves headers undefined", async () => {
    const adapter = makeAdapter();
    const upload = await adapter.signedUploadUrl("plain.bin", {
      expiresIn: 30,
    });
    if (upload.method !== "PUT") {
      throw new Error("expected a PUT upload");
    }
    expect(upload.headers).toBeUndefined();
    expect(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "host"
    );
  });

  test("signedUploadUrl fails closed on maxSize", async () => {
    const adapter = makeAdapter({ providerLabel: "R2 error" });
    const error = await expectCode(
      adapter.signedUploadUrl("a.bin", { expiresIn: 60, maxSize: 1024 }),
      "Provider"
    );
    expect(error.message).toMatch(/^R2 error: `maxSize` requires/u);
    expect(error.permanent).toBe(true);
  });
});

describe("s3-fetch core — error handling", () => {
  test("network failures map to Provider errors", async () => {
    const adapter = makeAdapter({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = await expectCode(adapter.download("a.txt"), "Provider");
    expect(error.message).toBe("fetch failed");
  });

  test("PreconditionFailed maps to Conflict", async () => {
    const adapter = makeAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            "<Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>",
            { status: 412 }
          )
        ),
    });
    const error = await expectCode(adapter.download("a.txt"), "Conflict");
    expect(error.message).toBe("changed");
  });

  test("unclassified failures fall back to the provider label", async () => {
    const adapter = makeAdapter({
      fetch: () =>
        Promise.resolve(new Response("not xml at all", { status: 500 })),
      providerLabel: "R2 error",
    });
    const error = await expectCode(adapter.download("a.txt"), "Provider");
    expect(error.message).toBe("R2 error");
  });

  test("tolerates unreadable response bodies", async () => {
    let call = 0;
    const responses = [
      // upload: 200 whose body can't be drained still succeeds.
      () =>
        new Response(erroringBody(), {
          headers: { etag: '"e1"' },
          status: 200,
        }),
      // download: 500 whose body can't be read still maps by status.
      () => new Response(erroringBody(), { status: 500 }),
    ];
    const adapter = makeAdapter({
      fetch: () => {
        const respond = responses[call] as () => Response;
        call += 1;
        return Promise.resolve(respond());
      },
    });
    const result = await adapter.upload("a.txt", "x");
    expect(result.etag).toBe("e1");
    await expectCode(adapter.download("a.txt"), "Provider");
  });

  test("download as stream tolerates a bodyless success response", async () => {
    const adapter = makeAdapter({
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
    });
    const file = await adapter.download("empty.txt", { as: "stream" });
    expect(await file.text()).toBe("");
  });

  test("invalid last-modified headers are dropped rather than NaN", async () => {
    const adapter = makeAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            headers: {
              "content-length": "3",
              "last-modified": "not a date",
            },
            status: 200,
          })
        ),
    });
    const file = await adapter.head("weird.txt");
    expect(file.lastModified).toBeUndefined();
    expect(file.size).toBe(3);
    expect(file.type).toBe("application/octet-stream");
  });

  test("falls back to globalThis.fetch when no fetch override is given", async () => {
    const fake = makeFakeS3();
    const original = globalThis.fetch;
    globalThis.fetch = fake.fetchImpl as typeof globalThis.fetch;
    try {
      const adapter = makeAdapter();
      await adapter.upload("global.txt", "via global fetch");
      const file = await adapter.download("global.txt");
      expect(await file.text()).toBe("via global fetch");
    } finally {
      globalThis.fetch = original;
    }
  });
});
