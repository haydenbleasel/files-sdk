import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { connect, createServer } from "node:http2";
import type { AddressInfo } from "node:net";

import type { FilesApi } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import { createFiles } from "../src/index.js";
import type { NodeLikeRequest } from "../src/internal/node-http.js";
import { handleNodeRequest, toWebRequest } from "../src/internal/node-http.js";
import { memory } from "../src/memory/index.js";

// The shape `node:http2`'s compat API hands a request handler: the
// pseudo-headers ride in `rawHeaders`/`headers`, and there may be no `Host`.
const http2Request = (
  rawHeaders: string[],
  headers: Record<string, string>
): NodeLikeRequest =>
  ({
    headers,
    method: "GET",
    rawHeaders,
    socket: {},
    url: "/api/files?op=download&key=a.txt",
  }) as unknown as NodeLikeRequest & IncomingMessage;

describe("toWebRequest", () => {
  test("drops HTTP/2 pseudo-headers and takes the host from :authority", () => {
    const req = toWebRequest(
      http2Request(
        [
          ":method",
          "GET",
          ":path",
          "/api/files?op=download&key=a.txt",
          ":authority",
          "app.test:8443",
          ":scheme",
          "https",
          "accept",
          "*/*",
        ],
        { ":authority": "app.test:8443", accept: "*/*" }
      ),
      new AbortController().signal
    );
    expect(req.url).toBe(
      "http://app.test:8443/api/files?op=download&key=a.txt"
    );
    expect([...req.headers.keys()]).toEqual(["accept"]);
  });

  test("a Host header still wins over :authority", () => {
    const req = toWebRequest(
      http2Request(["host", "host.test"], {
        ":authority": "authority.test",
        host: "host.test",
      }),
      new AbortController().signal
    );
    expect(new URL(req.url).host).toBe("host.test");
  });
});

describe("handleNodeRequest over node:http2", () => {
  test("serves a gateway op instead of failing every request", async () => {
    const files = createFiles({ adapter: memory() });
    await files.upload("a.txt", "hello");
    const router: FilesApi = createFilesRouter({
      files,
      operations: ["head"],
      secret: "s",
    });
    const server = createServer((req, res) => {
      void handleNodeRequest(
        router,
        // SAFETY: the compat request/response carry every member the bridge
        // reads (`rawHeaders`, `headers`, `method`, `url`, `socket`, and the
        // response's status/header/stream API).
        req as unknown as NodeLikeRequest,
        res as never
      );
    });
    const listening = Promise.withResolvers<null>();
    server.listen(0, () => listening.resolve(null));
    await listening.promise;
    const { port } = server.address() as AddressInfo;
    const client = connect(`http://localhost:${port}`);
    try {
      const done = Promise.withResolvers<{ status: number; body: string }>();
      const stream = client.request({
        ":method": "POST",
        ":path": "/api/files",
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.setEncoding("utf-8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => done.resolve({ body, status }));
      stream.on("error", done.reject);
      stream.end(JSON.stringify({ key: "a.txt", op: "head" }));
      const result = await done.promise;
      expect(result.status).toBe(200);
      expect(
        (JSON.parse(result.body) as { file: { key: string } }).file.key
      ).toBe("a.txt");
    } finally {
      client.close();
      const closed = Promise.withResolvers<null>();
      server.close(() => closed.resolve(null));
      await closed.promise;
    }
  });
});
