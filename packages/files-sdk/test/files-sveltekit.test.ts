// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import type { RequestEvent } from "@sveltejs/kit";

import type { FilesApi } from "../src/api/index.js";
import { createRouteHandler } from "../src/sveltekit/index.js";

const event = (req: Request): RequestEvent =>
  ({ request: req }) as unknown as RequestEvent;

describe("files-sdk/sveltekit", () => {
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
    expect((await GET(event(new Request(url)))).status).toBe(200);
    expect(
      (await POST(event(new Request(url, { method: "POST" })))).status
    ).toBe(200);
    expect((await PUT(event(new Request(url, { method: "PUT" })))).status).toBe(
      200
    );
    expect(seen).toEqual(["GET", "POST", "PUT"]);
  });
});
