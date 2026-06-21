// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import type { FilesApi } from "../src/api/index.js";
import { createRouteHandler } from "../src/next/index.js";

describe("files-sdk/next", () => {
  test("GET, POST and PUT all forward to router.handle", async () => {
    const seen: string[] = [];
    const router: FilesApi = {
      handle: (req) => {
        seen.push(req.method);
        return Promise.resolve(new Response("ok"));
      },
    };
    const { GET, POST, PUT } = createRouteHandler(router);
    const url = "https://app.test/api/files";
    expect((await GET(new Request(url))).status).toBe(200);
    expect((await POST(new Request(url, { method: "POST" }))).status).toBe(200);
    expect((await PUT(new Request(url, { method: "PUT" }))).status).toBe(200);
    expect(seen).toEqual(["GET", "POST", "PUT"]);
  });
});
