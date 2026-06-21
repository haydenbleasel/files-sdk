import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

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

    // Resolves only once `abortSignalForNodeRequest` forwarded the socket close
    // to the signal the gateway threads into `files.download`.
    await upstreamAborted.promise;
    expect(true).toBe(true);
  });
});
