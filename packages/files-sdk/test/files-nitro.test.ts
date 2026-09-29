import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, Agent } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { createApp, eventHandler, toPlainHandler, toWebHandler } from "h3";
import type { H3Event } from "h3";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createFiles } from "../src/index.js";
import { sendWebResponse } from "../src/internal/node-http.js";
import { memory } from "../src/memory/index.js";
import { createRouteHandler } from "../src/nitro/index.js";

// Drive the binding through a real Node server, shaping a minimal h3 event
// (`{ node: { req, res } }`) the way Nitro does, then flush the Response the
// handler returns — exactly what Nitro does after the event handler resolves.
let server: Server | undefined;

const serve = (router: FilesApi): Promise<string> => {
  const handler = createRouteHandler(router);
  const s = createServer((req, res) => {
    const event = { node: { req, res } } as unknown as H3Event;
    handler(event)
      .then((response) => sendWebResponse(res, response))
      .catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
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

describe("files-sdk/nitro", () => {
  test("marshals the h3 event into a Request and answers a gateway op", async () => {
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

  test("forwards the method and streams a PUT body to the gateway", async () => {
    const router: FilesApi = {
      handle: async (req) => new Response(`${req.method}:${await req.text()}`),
    };
    const url = await serve(router);

    const res = await fetch(`${url}?op=upload&key=a.txt`, {
      body: "the-bytes",
      method: "PUT",
    });
    expect(await res.text()).toBe("PUT:the-bytes");
  });

  test("aborts the request signal when the client disconnects mid-stream", async () => {
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
                  // The binding may already have cancelled the stream when it
                  // tore down the response (Bun does); closing again throws.
                  try {
                    controller.close();
                  } catch {
                    // already closed by the binding
                  }
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

    // Resolves only once `abortSignalForNodeRequest` forwarded the socket close
    // to the signal the gateway threads into `files.download`.
    await upstreamAborted.promise;
    expect(true).toBe(true);
  });

  test("does not accumulate socket listeners across keep-alive requests", async () => {
    const counts: number[] = [];
    const handler = createRouteHandler({
      handle: () => Promise.resolve(new Response("ok")),
    });
    const s = createServer((req, res) => {
      const event = { node: { req, res } } as unknown as H3Event;
      res.once("close", () => {
        counts.push(req.socket.listenerCount("close"));
      });
      void handler(event).then((response) => sendWebResponse(res, response));
    });
    server = s;
    const ready = Promise.withResolvers<number>();
    s.listen(0, "127.0.0.1", () => {
      ready.resolve((s.address() as AddressInfo).port);
    });
    const port = await ready.promise;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    for (let i = 0; i < 15; i += 1) {
      const done = Promise.withResolvers<null>();
      const req = httpRequest(
        { agent, host: "127.0.0.1", method: "GET", path: "/api/files", port },
        (res: IncomingMessage) => {
          res.resume();
          res.on("end", () => done.resolve(null));
        }
      );
      req.end();
      // oxlint-disable-next-line no-await-in-loop -- sequential requests share one keep-alive socket
      await done.promise;
    }
    agent.destroy();
    expect(counts).toHaveLength(15);
    // Every request detached its listener: the count never grows.
    expect(new Set(counts).size).toBe(1);
  });
});

const capabilitiesRouter = () =>
  createFilesRouter({
    files: createFiles({ adapter: memory() }),
    operations: ["capabilities"],
    secret: "nitro-secret",
  });

// Nitro's `localFetch` hands the route a node-mock-http request: no socket
// event API, payload on `req.body`.
const mockEvent = (fields: Record<string, unknown>, method = "POST") =>
  ({
    node: {
      req: {
        __unenv__: {},
        headers: { host: "app.test" },
        method,
        rawHeaders: ["host", "app.test"],
        socket: {},
        url: "/api/files",
        ...fields,
      },
      res: {},
    },
  }) as unknown as H3Event;

describe("files-sdk/nitro — in-process requests", () => {
  const echo: FilesApi = {
    handle: async (req) =>
      new Response(
        `${req.method} ${new URL(req.url).pathname}:${await req.text()}`
      ),
  };

  test("uses the event's Web Request when h3 has one (toWebHandler)", async () => {
    const app = createApp();
    app.use(
      "/api/files",
      eventHandler(createRouteHandler(capabilitiesRouter()))
    );
    const res = await toWebHandler(app)(
      new Request("https://app.test/api/files", {
        body: JSON.stringify({ op: "capabilities" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { delimiter: boolean } };
    expect(typeof body.capabilities.delimiter).toBe("boolean");
  });

  test("reads a node-mock-http request's body from the event (toPlainHandler)", async () => {
    const app = createApp();
    app.use(
      "/api/files",
      eventHandler(createRouteHandler(capabilitiesRouter()))
    );
    const res = await toPlainHandler(app)({
      body: JSON.stringify({ op: "capabilities" }),
      headers: { "content-type": "application/json", host: "app.test" },
      method: "POST",
      path: "/api/files",
    });
    expect(res.status).toBe(200);
    const text = await new Response(res.body as BodyInit).text();
    expect(JSON.parse(text).capabilities).toBeDefined();
  });

  test("reads req.body / req.rawBody in every shape h3 accepts", async () => {
    const handler = createRouteHandler(echo);
    const cases: [Record<string, unknown>, string][] = [
      [{ body: "text" }, "text"],
      [{ body: new TextEncoder().encode("bytes") }, "bytes"],
      [{ body: { op: "capabilities" } }, '{"op":"capabilities"}'],
      [
        { body: Readable.from([Buffer.from("node-")], { objectMode: false }) },
        "node-",
      ],
      [{ body: 42 }, "42"],
      [{ rawBody: "raw" }, "raw"],
      [{ body: null }, ""],
      [{}, ""],
    ];
    for (const [fields, expected] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      const res = await handler(mockEvent(fields));
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      expect(await res.text()).toBe(`POST /api/files:${expected}`);
    }
    const get = await handler(mockEvent({ body: "ignored" }, "GET"));
    expect(await get.text()).toBe("GET /api/files:");
  });
});
