// oxlint-disable unicorn/consistent-function-scoping, max-classes-per-file, class-methods-use-this -- in-test fetch/transport stubs and XHR mock classes.
import { afterEach, describe, expect, test } from "bun:test";

import { decodeDownload } from "../src/client/download-decode.js";
import { createFilesClient } from "../src/client/index.js";
import type { FileUploadState } from "../src/client/progress.js";
import { fileName, initialState } from "../src/client/progress.js";
import type { SendRequest, Transport } from "../src/client/transport.js";
import { fetchTransport, xhrTransport } from "../src/client/transport.js";
import type { NativeFileRef } from "../src/client/types.js";
import { isNativeFileRef } from "../src/client/types.js";

const ENDPOINT = "https://app.test/api/files";

const fetchReturning = (response: () => Response): typeof fetch =>
  (() => Promise.resolve(response())) as unknown as typeof fetch;

const okStub = fetchReturning(() => new Response("{}", { status: 200 }));

describe("client error mapping", () => {
  const cases: [string, number, string][] = [
    ["NotFound", 404, "NotFound"],
    ["Conflict", 409, "Conflict"],
    ["ReadOnly", 403, "ReadOnly"],
    ["Unauthorized", 401, "Unauthorized"],
    ["Forbidden", 403, "Unauthorized"],
    ["Validation", 422, "Provider"],
    ["Mystery", 500, "Provider"],
  ];
  for (const [wire, status, mapped] of cases) {
    test(`${wire} → ${mapped}`, async () => {
      const client = createFilesClient({
        endpoint: ENDPOINT,
        fetchImpl: fetchReturning(() =>
          Response.json({ error: { code: wire, message: wire } }, { status })
        ),
      });
      await expect(client.exists("k")).rejects.toMatchObject({ code: mapped });
    });
  }

  test("non-JSON error body falls back to Provider", async () => {
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: fetchReturning(() => new Response("boom", { status: 500 })),
    });
    await expect(client.exists("k")).rejects.toMatchObject({
      code: "Provider",
    });
  });
});

describe("upload edge paths", () => {
  const presignFetch = (uploads: unknown, complete?: unknown): typeof fetch =>
    ((_input: unknown, init?: RequestInit) => {
      const { op } = JSON.parse(String(init?.body));
      const body = op === "presign" ? { uploads } : (complete ?? { files: [] });
      return Promise.resolve(Response.json(body, { status: 200 }));
    }) as unknown as typeof fetch;

  test("sendToTarget throws on a non-2xx storage response", async () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 500, text: "" });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: presignFetch([
        { id: "t", key: "k", target: { method: "PUT", url: "https://s/up" } },
      ]),
      transport,
    });
    await expect(client.upload(new Blob(["x"]))).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("empty presign result throws", async () => {
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: presignFetch([]),
      transport: () => Promise.resolve({ status: 200, text: "" }),
    });
    await expect(client.upload(new Blob(["x"]))).rejects.toThrow(
      /no upload target/u
    );
  });

  test("complete error surfaces", async () => {
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: presignFetch(
        [{ id: "t", key: "k", target: { method: "PUT", url: "https://s/up" } }],
        {
          errors: [
            {
              error: {
                aborted: false,
                code: "Provider",
                message: "boom",
                timedOut: false,
              },
              key: "k",
            },
          ],
          files: [],
        }
      ),
      transport: () => Promise.resolve({ status: 200, text: "" }),
    });
    await expect(client.upload(new Blob(["x"]))).rejects.toMatchObject({
      message: "boom",
    });
  });

  test("explicit upload surfaces a gateway error", async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 403,
        text: JSON.stringify({
          error: { code: "Unauthorized", message: "no" },
        }),
      });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport,
    });
    await expect(client.upload("k", "body")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("explicit upload non-JSON failure → Provider", async () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 500, text: "oops" });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport,
    });
    await expect(client.upload("k", new ArrayBuffer(2))).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("uploadMany collects per-item failures", async () => {
    const transport: Transport = (req) =>
      Promise.resolve(
        req.url.includes("bad")
          ? { status: 500, text: "" }
          : {
              status: 200,
              text: JSON.stringify({
                file: { key: "good", size: 1, type: "x" },
              }),
            }
      );
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport,
    });
    const result = await client.upload([
      { body: "1", key: "good" },
      { body: "2", key: "bad" },
    ]);
    expect(result.uploaded).toHaveLength(1);
    expect(result.errors?.[0]?.key).toBe("bad");
  });
});

describe("download edge paths", () => {
  test("downloadMany collects per-key failures", async () => {
    const fetchImpl = fetchReturning(
      () => new Response("data", { status: 200 })
    );
    const failing = ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("missing")
          ? Response.json(
              { error: { code: "NotFound", message: "x" } },
              { status: 404 }
            )
          : new Response("data", {
              headers: { "content-length": "4", "content-type": "text/plain" },
              status: 200,
            })
      )) as unknown as typeof fetch;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: failing,
    });
    const result = await client.download(["ok", "missing"]);
    expect(result.downloaded).toHaveLength(1);
    expect(result.errors?.[0]?.key).toBe("missing");
    expect(fetchImpl).toBeDefined();
  });

  test("decodeDownload tolerates a malformed meta header", () => {
    const res = new Response("bytes", {
      headers: { "content-length": "5", "x-files-meta": "@@@not-base64" },
    });
    const file = decodeDownload(res, "fallback-key");
    expect(file.key).toBe("fallback-key");
    expect(file.size).toBe(5);
  });

  test("decodeDownload buffers via arrayBuffer when Response.body is missing", async () => {
    // React Native's fetch never exposes `Response.body`.
    const data = new TextEncoder().encode("hello");
    const res = {
      arrayBuffer: () => Promise.resolve(data.buffer),
      body: null,
      headers: new Headers({
        "content-length": "5",
        "content-type": "text/plain",
      }),
    } as unknown as Response;
    const file = decodeDownload(res, "k");
    expect(file.size).toBe(5);
    expect(await file.text()).toBe("hello");
  });

  test("decodeDownload hands blob() the Response's native Blob on RN", async () => {
    // React Native: no `Response.body`, and Blob rejects byte parts — blob()
    // must consume `Response.blob()` instead of constructing from bytes.
    const RealBlob = globalThis.Blob;
    globalThis.Blob = class extends RealBlob {
      constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
        if (
          parts?.some((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p))
        ) {
          throw new Error(
            "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"
          );
        }
        super(parts, opts);
      }
    };
    try {
      const native = new RealBlob(["hello"], { type: "text/plain" });
      const res = {
        arrayBuffer: () => Promise.reject(new Error("already consumed")),
        blob: () => Promise.resolve(native),
        body: null,
        headers: new Headers({
          "content-length": "5",
          "content-type": "text/plain",
        }),
      } as unknown as Response;
      const file = decodeDownload(res, "k");
      expect(await file.blob()).toBe(native);
      // Byte accessors afterwards read back through the Blob, not the Response.
      expect(await file.text()).toBe("hello");
    } finally {
      globalThis.Blob = RealBlob;
    }
  });
});

describe("react-native fallbacks", () => {
  const RealBlob = globalThis.Blob;
  afterEach(() => {
    globalThis.Blob = RealBlob;
  });

  // Mimic React Native's Blob, which rejects ArrayBuffer/TypedArray parts.
  const installByteRejectingBlob = () => {
    globalThis.Blob = class extends RealBlob {
      constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
        if (
          parts?.some((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p))
        ) {
          throw new Error(
            "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"
          );
        }
        super(parts, opts);
      }
    };
  };

  const captureTransport =
    (onSend: (req: SendRequest) => void, size: number): Transport =>
    (req) => {
      onSend(req);
      req.onProgress?.(size, size);
      return Promise.resolve({
        status: 200,
        text: JSON.stringify({
          file: { key: "k", size, type: "application/octet-stream" },
        }),
      });
    };

  test("byte upload falls back to raw bytes when Blob rejects buffer parts", async () => {
    installByteRejectingBlob();
    let sent: SendRequest | undefined;
    const states: FileUploadState[] = [];
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport: captureTransport((req) => {
        sent = req;
      }, 3),
    });
    const out = await client.upload("k", new Uint8Array([1, 2, 3]), {
      contentType: "application/x-thing",
      onProgress: (_agg, perFile) => states.push(...perFile),
    });
    expect(out.key).toBe("k");
    expect(sent?.body).toBeInstanceOf(Uint8Array);
    expect(sent?.headers?.["content-type"]).toBe("application/x-thing");
    expect(states[0]?.size).toBe(3);
    expect(states[0]?.name).toBe("blob");
    expect(states[0]?.progress).toBe(1);
  });

  test("byte fallback without contentType defaults the header", async () => {
    installByteRejectingBlob();
    let sent: SendRequest | undefined;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport: captureTransport((req) => {
        sent = req;
      }, 2),
    });
    await client.upload("k", new ArrayBuffer(2));
    expect(sent?.body).toBeInstanceOf(Uint8Array);
    expect(sent?.headers?.["content-type"]).toBe("application/octet-stream");
  });

  test("fetchTransport reports byte-body size", async () => {
    const totals: number[] = [];
    const transport = fetchTransport(
      fetchReturning(() => new Response("{}", { status: 200 }))
    );
    await transport({
      body: new Uint8Array(4),
      method: "PUT",
      onProgress: (_loaded, total) => totals.push(total),
      url: "https://s/up",
    });
    expect(totals).toEqual([4, 4]);
  });

  test("presigned POST wraps a raw-byte body into a Blob form part", async () => {
    let sentBody: FormData | undefined;
    const Capture = class {
      private readonly handlers: Record<string, (() => void)[]> = {};
      upload = { addEventListener: () => {} };
      status = 204;
      responseText = "";
      open() {
        /* noop */
      }
      setRequestHeader() {
        /* noop */
      }
      addEventListener(type: string, handler: () => void) {
        (this.handlers[type] ??= []).push(handler);
      }
      send(body?: unknown) {
        sentBody = body as FormData;
        for (const handler of this.handlers.load ?? []) {
          handler();
        }
      }
      abort() {
        /* noop */
      }
    };
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Capture;
    try {
      const result = await xhrTransport({
        body: new Uint8Array([7]),
        fields: { key: "k" },
        method: "POST",
        url: "https://s/up",
      });
      expect(result.status).toBe(204);
      expect(sentBody?.get("file")).toBeInstanceOf(Blob);
      expect(sentBody?.get("key")).toBe("k");
    } finally {
      // @ts-expect-error -- cleanup
      delete globalThis.XMLHttpRequest;
    }
  });
});

describe("xhrTransport failure + abort", () => {
  afterEach(() => {
    // @ts-expect-error -- cleanup
    delete globalThis.XMLHttpRequest;
  });

  const baseXhr = () =>
    class {
      private readonly listeners: Record<string, (() => void)[]> = {};
      upload = { addEventListener: () => {} };
      status = 200;
      responseText = "{}";
      open() {
        /* noop */
      }
      setRequestHeader() {
        /* noop */
      }
      addEventListener(type: string, handler: () => void) {
        (this.listeners[type] ??= []).push(handler);
      }
      dispatch(type: string) {
        for (const handler of this.listeners[type] ?? []) {
          handler();
        }
      }
      abort() {
        this.dispatch("abort");
      }
      send() {
        /* overridden */
      }
    };

  test("rejects on a network error", async () => {
    const Err = class extends baseXhr() {
      override send() {
        this.dispatch("error");
      }
    };
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Err;
    await expect(
      xhrTransport({ body: new Blob(["x"]), method: "PUT", url: "u" })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("aborts when a live signal fires", async () => {
    const Pending = class extends baseXhr() {
      override send() {
        /* never resolves on its own */
      }
    };
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Pending;
    const controller = new AbortController();
    const promise = xhrTransport({
      body: new Blob(["x"]),
      method: "PUT",
      signal: controller.signal,
      url: "u",
    });
    controller.abort(new Error("stop"));
    await expect(promise).rejects.toMatchObject({ aborted: true });
  });
});

describe("native file refs", () => {
  const REF_URI = "file:///docs/photo.png";

  // Serves the picker uri as bytes and everything else as the gateway.
  const refAwareFetch = (
    uploads: unknown,
    posts: unknown[] = []
  ): typeof fetch =>
    ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("file://")) {
        return Promise.resolve(
          new Response(new Blob(["native bytes!"], { type: "image/png" }))
        );
      }
      const payload = JSON.parse(String(init?.body)) as { op: string };
      posts.push(payload);
      const body =
        payload.op === "presign"
          ? { uploads }
          : { files: [{ key: "k", size: 13, type: "image/png" }] };
      return Promise.resolve(Response.json(body, { status: 200 }));
    }) as unknown as typeof fetch;

  const okTransport =
    (capture: (req: SendRequest) => void): Transport =>
    (req) => {
      capture(req);
      req.onProgress?.(0, 0);
      return Promise.resolve({ status: 200, text: "{}" });
    };

  test("isNativeFileRef accepts only uri-carrying plain objects", () => {
    expect(isNativeFileRef({ uri: "file:///x" })).toBe(true);
    expect(isNativeFileRef(null)).toBe(false);
    expect(isNativeFileRef("file:///x")).toBe(false);
    expect(isNativeFileRef(new Blob(["x"]))).toBe(false);
    expect(isNativeFileRef({ name: "no-uri" })).toBe(false);
  });

  test("keyless ref upload resolves to a Blob for a PUT target", async () => {
    const posts: { op: string; files?: { name: string; size: number }[] }[] =
      [];
    let sent: SendRequest | undefined;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: refAwareFetch(
        [{ id: "t", key: "k", target: { method: "PUT", url: "https://s/up" } }],
        posts
      ),
      transport: okTransport((req) => {
        sent = req;
      }),
    });
    const out = await client.upload({ type: "image/png", uri: REF_URI });
    expect(out.key).toBe("k");
    expect(sent?.body).toBeInstanceOf(Blob);
    // presign info derives the name from the uri and defaults size to 0
    expect(posts[0]?.files?.[0]?.name).toBe("photo.png");
    expect(posts[0]?.files?.[0]?.size).toBe(0);
  });

  test("keyless ref upload rides the form untouched on a POST target", async () => {
    const ref: NativeFileRef = {
      name: "pic.png",
      size: 5,
      type: "image/png",
      uri: REF_URI,
    };
    let sent: SendRequest | undefined;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: refAwareFetch([
        {
          id: "t",
          key: "k",
          target: {
            fields: { acl: "private" },
            method: "POST",
            url: "https://s/up",
          },
        },
      ]),
      transport: okTransport((req) => {
        sent = req;
      }),
    });
    const states: FileUploadState[] = [];
    await client.upload(ref, {
      onProgress: (_agg, perFile) => states.push(...perFile),
    });
    expect(sent?.body).toBe(ref);
    expect(sent?.fields).toEqual({ acl: "private" });
    expect(states[0]?.name).toBe("pic.png");
    expect(states[0]?.size).toBe(5);
  });

  test("explicit ref upload resolves bytes and uses the ref's type", async () => {
    let sent: SendRequest | undefined;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: refAwareFetch([]),
      transport: (req) => {
        sent = req;
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({
            file: { key: "k", size: 13, type: "image/png" },
          }),
        });
      },
    });
    const out = await client.upload("k", { type: "image/png", uri: REF_URI });
    expect(out.size).toBe(13);
    expect(sent?.body).toBeInstanceOf(Blob);
    expect(sent?.headers?.["content-type"]).toBe("image/png");
  });

  test("explicit contentType overrides the ref's type", async () => {
    let sent: SendRequest | undefined;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: refAwareFetch([]),
      transport: (req) => {
        sent = req;
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({
            file: { key: "k", size: 13, type: "image/webp" },
          }),
        });
      },
    });
    await client.upload(
      "k",
      { type: "image/png", uri: REF_URI },
      {
        contentType: "image/webp",
      }
    );
    expect(sent?.headers?.["content-type"]).toBe("image/webp");
  });

  test("an unreadable ref uri rejects with a Provider error", async () => {
    const failing = ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).startsWith("file://")
          ? new Response(null, { status: 404 })
          : new Response("{}", { status: 200 })
      )) as unknown as typeof fetch;
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: failing,
    });
    await expect(
      client.upload("k", { uri: "file:///gone.png" })
    ).rejects.toThrow(/could not read upload source/u);
  });

  test("a raw-body transport path rejects an unresolved ref", async () => {
    const transport = fetchTransport(okStub);
    await expect(
      transport({ body: { uri: REF_URI }, method: "PUT", url: "https://s/up" })
    ).rejects.toThrow(/requires a presigned-POST target/u);
  });

  test("fetchTransport appends a ref to the form and reports its size", async () => {
    const RealFormData = globalThis.FormData;
    const parts: [string, unknown][] = [];
    globalThis.FormData = class {
      append(key: string, value: unknown) {
        parts.push([key, value]);
      }
    } as unknown as typeof FormData;
    try {
      const ref: NativeFileRef = { size: 5, uri: REF_URI };
      const totals: number[] = [];
      const transport = fetchTransport(okStub);
      await transport({
        body: ref,
        fields: { key: "k" },
        method: "POST",
        onProgress: (_loaded, total) => totals.push(total),
        url: "https://s/up",
      });
      expect(totals).toEqual([5, 5]);
      expect(parts).toEqual([
        ["key", "k"],
        ["file", ref],
      ]);
    } finally {
      globalThis.FormData = RealFormData;
    }
  });

  test("fetchTransport tolerates a null body", async () => {
    const totals: number[] = [];
    const transport = fetchTransport(okStub);
    await transport({
      body: null,
      method: "PUT",
      onProgress: (_loaded, total) => totals.push(total),
      url: "https://s/up",
    });
    expect(totals).toEqual([0, 0]);
  });

  test("progress helpers understand refs", () => {
    const named = initialState({
      name: "n.png",
      size: 7,
      type: "image/png",
      uri: REF_URI,
    });
    expect(named.name).toBe("n.png");
    expect(named.size).toBe(7);
    expect(named.type).toBe("image/png");

    const bare = initialState({ uri: "file:///a/b.pdf" });
    expect(bare.name).toBe("b.pdf");
    expect(bare.size).toBe(0);
    expect(bare.type).toBe("application/octet-stream");

    expect(fileName({ uri: "file:///dir/?query" })).toBe("blob");
  });
});
