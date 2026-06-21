// `files-sdk/express` — mount a `createFilesRouter` (or any `{ handle }`) on a
// Node server. Unlike the Web-native bindings, Express/Connect/`node:http` hand
// you a Node `IncomingMessage`/`ServerResponse` pair, so this bridges them to
// the Web `Request`/`Response` the gateway speaks (`Readable.toWeb`/`fromWeb` +
// `pipeline`, the same seam the CLI uses). It is typed against `node:http`, so it
// works with Express, Connect, and a raw `http.createServer` alike.
//
//   import express from "express";
//   const app = express();
//   app.all("/api/files", createRouteHandler(router));
//
// IMPORTANT: mount this BEFORE any body parser (`express.json()` / `urlencoded`),
// or scope the parser to exclude this route. A body parser consumes the request
// stream — the gateway must read the raw bytes itself (the JSON verbs and the
// proxy/explicit-key PUT upload both need the untouched body).

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { TLSSocket } from "node:tls";

import type { FilesApi } from "../api/index.js";

/** A Node request, optionally carrying Express's `originalUrl` (the pre-mount path). */
export type ExpressLikeRequest = IncomingMessage & { originalUrl?: string };

export type ExpressRouteHandler = (
  req: ExpressLikeRequest,
  res: ServerResponse
) => Promise<void>;

/** Best-effort scheme: trust `x-forwarded-proto`, else the socket's TLS flag. */
const requestProtocol = (req: IncomingMessage): string => {
  const header = req.headers["x-forwarded-proto"];
  const forwarded = (Array.isArray(header) ? header[0] : header)
    ?.split(",")[0]
    ?.trim();
  if (forwarded) {
    return forwarded;
  }
  return (req.socket as TLSSocket | undefined)?.encrypted ? "https" : "http";
};

/** Marshal a Node request into the Web `Request` the gateway consumes. */
const toWebRequest = (
  req: ExpressLikeRequest,
  signal: AbortSignal
): Request => {
  const base = `${requestProtocol(req)}://${req.headers.host ?? "localhost"}`;
  const url = new URL(req.originalUrl ?? req.url ?? "/", base);

  // `rawHeaders` is a flat [k, v, k, v, …] list — appending each pair preserves
  // duplicates without the string|string[] branching of `req.headers`.
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(
      req.rawHeaders[i] as string,
      req.rawHeaders[i + 1] as string
    );
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { headers, method, signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
};

/** Flush a Web `Response` (status, headers, streamed body) onto the Node response. */
const sendWebResponse = async (
  res: ServerResponse,
  response: Response
): Promise<void> => {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    res.setHeader(key, value);
  }
  if (response.body) {
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as NodeReadableStream<Uint8Array>
      ),
      res
    );
  } else {
    res.end();
  }
};

export const createRouteHandler =
  (router: FilesApi): ExpressRouteHandler =>
  async (req, res) => {
    // Wire a client disconnect through to the upstream read: abort the signal the
    // proxy-download path threads into `files.download` when the client goes away
    // before the response finishes. The connection socket's `close` is the one
    // disconnect event that fires across Node and Bun; `writableFinished` guards
    // it so a normally-completed (or keep-alive) socket never aborts.
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    };
    req.socket?.once("close", onClose);
    try {
      const response = await router.handle(
        toWebRequest(req, controller.signal)
      );
      await sendWebResponse(res, response);
    } catch {
      // `router.handle` never throws (it returns an error Response), so this is a
      // marshalling/transport failure — disconnect mid-stream, or a malformed
      // request line. Send a 500 only if nothing has been written yet.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    } finally {
      req.socket?.removeListener("close", onClose);
    }
  };
