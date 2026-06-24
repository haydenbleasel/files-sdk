// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import type { FilesApi } from "../src/api/index.js";
import { createRouteHandler } from "../src/tanstack-start/index.js";

describe("files-sdk/tanstack-start", () => {
  test("GET, POST and PUT all forward the request to router.handle", async () => {
    const seen: string[] = [];
    const router: FilesApi = {
      handle: (req) => {
        seen.push(req.method);
        return Promise.resolve(new Response("ok"));
      },
    };
    const { GET, POST, PUT } = createRouteHandler(router);
    const url = "https://app.test/api/files";
    expect((await GET({ request: new Request(url) })).status).toBe(200);
    expect(
      (await POST({ request: new Request(url, { method: "POST" }) })).status
    ).toBe(200);
    expect(
      (await PUT({ request: new Request(url, { method: "PUT" }) })).status
    ).toBe(200);
    expect(seen).toEqual(["GET", "POST", "PUT"]);
  });
});
