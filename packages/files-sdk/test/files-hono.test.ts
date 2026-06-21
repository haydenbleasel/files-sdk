// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import { Hono } from "hono";
import type { Context } from "hono";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createRouteHandler } from "../src/hono/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";

describe("files-sdk/hono", () => {
  test("forwards the underlying Request to router.handle", async () => {
    const seen: string[] = [];
    const router: FilesApi = {
      handle: (req) => {
        seen.push(req.method);
        return Promise.resolve(new Response("ok"));
      },
    };
    const handler = createRouteHandler(router);
    const c = {
      req: { raw: new Request("https://app.test/api/files") },
    } as unknown as Context;
    expect((await handler(c)).status).toBe(200);
    expect(seen).toEqual(["GET"]);
  });

  test("mounted on a real Hono app, answers a gateway op", async () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["capabilities"],
    });
    const app = new Hono();
    app.all("/api/files", createRouteHandler(router));

    const res = await app.request("/api/files", {
      body: JSON.stringify({ op: "capabilities" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { delimiter: boolean } };
    expect(typeof body.capabilities.delimiter).toBe("boolean");
  });
});
