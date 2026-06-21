// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createRouteHandler } from "../src/express/index.js";
import type { ExpressLikeRequest } from "../src/express/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";

// Drive the binding through a real Node server so the IncomingMessage /
// ServerResponse bridge is exercised end-to-end (the same surface Express hands
// it). `app.all(path, handler)` in Express is `(req, res) => handler(req, res)`.
let server: Server | undefined;

const serve = (
  router: FilesApi,
  prepare?: (req: ExpressLikeRequest) => void
): Promise<string> => {
  const handler = createRouteHandler(router);
  const s = createServer((req, res) => {
    prepare?.(req);
    void handler(req, res);
  });
  server = s;
  const ready = Promise.withResolvers<string>();
  s.listen(0, "127.0.0.1", () => {
    const addr = s.address() as AddressInfo;
    ready.resolve(`http://127.0.0.1:${addr.port}/api/files`);
  });
  return ready.promise;
};

afterEach(async () => {
  const s = server;
  if (!s) {
    return;
  }
  server = undefined;
  const closed = Promise.withResolvers<null>();
  s.close(() => {
    closed.resolve(null);
  });
  await closed.promise;
});

describe("files-sdk/express", () => {
  test("bridges a POST gateway op through a real Node server", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["capabilities"],
    });
    const url = await serve(router);

    const res = await fetch(url, {
      body: JSON.stringify({ op: "capabilities" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { delimiter: boolean } };
    expect(typeof body.capabilities.delimiter).toBe("boolean");
  });

  test("forwards a GET (no request body) and streams the response body", async () => {
    const router: FilesApi = {
      handle: (req) =>
        Promise.resolve(
          new Response(`method=${req.method} path=${new URL(req.url).pathname}`)
        ),
    };
    const url = await serve(router);

    const res = await fetch(`${url}?op=download&key=a.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("method=GET path=/api/files");
  });

  test("flushes a bodyless response", async () => {
    const router: FilesApi = {
      handle: () => Promise.resolve(new Response(null, { status: 204 })),
    };
    const url = await serve(router);

    const res = await fetch(url, { body: "{}", method: "POST" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("forwards request headers and honours x-forwarded-proto", async () => {
    const router: FilesApi = {
      handle: (req) => {
        const url = new URL(req.url);
        return Promise.resolve(
          new Response(`${url.protocol}|${req.headers.get("x-custom")}`)
        );
      },
    };
    const url = await serve(router);

    const res = await fetch(url, {
      headers: { "x-custom": "hi", "x-forwarded-proto": "https" },
    });
    // The URL is rebuilt as https so a signed proxy-upload target is correct
    // behind a TLS-terminating proxy; the custom header rides through verbatim.
    expect(await res.text()).toBe("https:|hi");
  });

  test("flushes the response status and headers onto the Node response", async () => {
    const router: FilesApi = {
      handle: () =>
        Promise.resolve(
          new Response("ok", {
            headers: { "x-files-meta": "abc" },
            status: 201,
          })
        ),
    };
    const url = await serve(router);

    const res = await fetch(url);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-files-meta")).toBe("abc");
    expect(await res.text()).toBe("ok");
  });

  test("streams a PUT request body through to the gateway", async () => {
    const router: FilesApi = {
      handle: async (req) => {
        const body = await req.text();
        return new Response(`${req.method}:${body}`);
      },
    };
    const url = await serve(router);

    const res = await fetch(`${url}?op=upload&key=a.txt`, {
      body: "the-bytes",
      method: "PUT",
    });
    expect(await res.text()).toBe("PUT:the-bytes");
  });

  test("builds the request URL from Express's originalUrl when present", async () => {
    const router: FilesApi = {
      handle: (req) => Promise.resolve(new Response(new URL(req.url).pathname)),
    };
    // Express rewrites `req.url` to the post-mount path; `originalUrl` keeps the
    // full path the client hit, which is what the proxy-upload URL must echo.
    const url = await serve(router, (req) => {
      req.originalUrl = "/mounted/files";
    });

    const res = await fetch(url);
    expect(await res.text()).toBe("/mounted/files");
  });

  test("replies 500 when marshalling/transport fails", async () => {
    const router: FilesApi = {
      handle: () => Promise.reject(new Error("boom")),
    };
    const url = await serve(router);

    const res = await fetch(url);
    expect(res.status).toBe(500);
  });

  test("aborts the upstream signal when the client disconnects mid-stream", async () => {
    const upstreamAborted = Promise.withResolvers<null>();
    const router: FilesApi = {
      handle: (req) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
                req.signal.addEventListener("abort", () => {
                  upstreamAborted.resolve(null);
                  controller.close();
                });
              },
            })
          )
        ),
    };
    const url = await serve(router);

    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal });
    // Read the first chunk, then drop the connection.
    await res.body?.getReader().read();
    ac.abort();

    // Resolves only once the binding forwarded the disconnect to the signal the
    // gateway threads into `files.download`; a missing wire-up hangs to timeout.
    await upstreamAborted.promise;
    expect(true).toBe(true);
  });
});
