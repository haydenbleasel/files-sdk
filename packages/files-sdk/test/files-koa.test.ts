// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import Koa from "koa";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createFiles } from "../src/index.js";
import { createRouteHandler } from "../src/koa/index.js";
import { memory } from "../src/memory/index.js";

// Drive the binding through a real Koa app so the `ctx.respond = false` +
// raw IncomingMessage/ServerResponse bridge is exercised end-to-end.
let server: Server | undefined;

const serve = (router: FilesApi): Promise<string> => {
  const app = new Koa();
  const files = createRouteHandler(router);
  app.use((ctx, next) => (ctx.path === "/api/files" ? files(ctx) : next()));
  const s = app.listen(0, "127.0.0.1");
  server = s;
  const ready = Promise.withResolvers<string>();
  s.on("listening", () => {
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

describe("files-sdk/koa", () => {
  test("cedes the response and answers a POST gateway op", async () => {
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
});
