// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createRouteHandler } from "../src/fastify/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";

// Drive the binding through a real Fastify app so the `reply.hijack()` +
// raw IncomingMessage/ServerResponse bridge is exercised end-to-end.
let app: FastifyInstance | undefined;

const serve = async (router: FilesApi): Promise<string> => {
  const instance = Fastify();
  // Don't let Fastify consume the body — the gateway reads the raw stream.
  // Dropping the built-in json/text parsers routes every content type through
  // the no-op catch-all, leaving `request.raw` intact for the gateway.
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser("*", (_req, _payload, done) => done(null));
  instance.all("/api/files", createRouteHandler(router));
  app = instance;
  await instance.listen({ host: "127.0.0.1", port: 0 });
  const addr = instance.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/api/files`;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("files-sdk/fastify", () => {
  test("hijacks the reply and answers a POST gateway op", async () => {
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

  test("streams a PUT request body through to the gateway", async () => {
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

  test("flushes the response status and headers onto the raw reply", async () => {
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
});
