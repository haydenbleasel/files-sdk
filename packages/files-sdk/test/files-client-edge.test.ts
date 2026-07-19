// oxlint-disable unicorn/consistent-function-scoping, max-classes-per-file, class-methods-use-this -- in-test fetch/transport stubs and XHR mock classes.
import { afterEach, describe, expect, test } from "bun:test";

import { decodeDownload } from "../src/client/download-decode.js";
import { createFilesClient } from "../src/client/index.js";
import type { FileUploadState } from "../src/client/progress.js";
import type { SendRequest, Transport } from "../src/client/transport.js";
import { fetchTransport, xhrTransport } from "../src/client/transport.js";

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
    test(`${wire} → ${mapped}`, () => {
      const client = createFilesClient({
        endpoint: ENDPOINT,
        fetchImpl: fetchReturning(() =>
          Response.json({ error: { code: wire, message: wire } }, { status })
        ),
      });
      expect(client.exists("k")).rejects.toMatchObject({ code: mapped });
    });
  }

  test("non-JSON error body falls back to Provider", () => {
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: fetchReturning(() => new Response("boom", { status: 500 })),
    });
    expect(client.exists("k")).rejects.toMatchObject({ code: "Provider" });
  });
});

describe("upload edge paths", () => {
  const presignFetch = (uploads: unknown, complete?: unknown): typeof fetch =>
    ((_input: unknown, init?: RequestInit) => {
      const { op } = JSON.parse(String(init?.body));
      const body = op === "presign" ? { uploads } : (complete ?? { files: [] });
      return Promise.resolve(Response.json(body, { status: 200 }));
    }) as unknown as typeof fetch;

  test("sendToTarget throws on a non-2xx storage response", () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 500, text: "" });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: presignFetch([
        { id: "t", key: "k", target: { method: "PUT", url: "https://s/up" } },
      ]),
      transport,
    });
    expect(client.upload(new Blob(["x"]))).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("empty presign result throws", () => {
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: presignFetch([]),
      transport: () => Promise.resolve({ status: 200, text: "" }),
    });
    expect(client.upload(new Blob(["x"]))).rejects.toThrow(/no upload target/u);
  });

  test("complete error surfaces", () => {
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
    expect(client.upload(new Blob(["x"]))).rejects.toMatchObject({
      message: "boom",
    });
  });

  test("explicit upload surfaces a gateway error", () => {
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
    expect(client.upload("k", "body")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("explicit upload non-JSON failure → Provider", () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 500, text: "oops" });
    const client = createFilesClient({
      endpoint: ENDPOINT,
      fetchImpl: okStub,
      transport,
    });
    expect(client.upload("k", new ArrayBuffer(2))).rejects.toMatchObject({
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

  test("rejects on a network error", () => {
    const Err = class extends baseXhr() {
      override send() {
        this.dispatch("error");
      }
    };
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Err;
    expect(
      xhrTransport({ body: new Blob(["x"]), method: "PUT", url: "u" })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("aborts when a live signal fires", () => {
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
    expect(promise).rejects.toMatchObject({ aborted: true });
  });
});
