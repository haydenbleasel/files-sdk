// The Node `IncomingMessage`/`ServerResponse` ↔ Web `Request`/`Response` seam
// shared by every Node-server binding (`express`, `koa`, `fastify`, `nitro`).
// Those frameworks hand you a Node request/response pair, but the gateway speaks
// Web `Request`/`Response`, so this marshals between them (`Readable.toWeb`/
// `fromWeb` + `pipeline`, the same seam the CLI uses) and wires a client
// disconnect through to the upstream read. Keeping it here means the
// disconnect-abort behaviour stays identical across the bindings instead of
// drifting in per-framework copies.

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import type { FilesApi } from "../api/index.js";
import { isObject } from "./is.js";
import { toNodeReadable, toWebStream } from "./node-stream";

/** A Node request, optionally carrying Express's `originalUrl` (the pre-mount path). */
export type NodeLikeRequest = IncomingMessage & { originalUrl?: string };

/** Best-effort scheme: trust `x-forwarded-proto`, else the socket's TLS flag. */
const requestProtocol = (req: IncomingMessage): string => {
  const header = req.headers["x-forwarded-proto"];
  const forwarded = (Array.isArray(header) ? header[0] : header)
    ?.split(",")[0]
    ?.trim();
  if (forwarded) {
    return forwarded;
  }
  // `TLSSocket` sets `encrypted: true`; a plain `Socket` has no such field.
  const { socket } = req;
  return isObject(socket) && "encrypted" in socket && socket.encrypted === true
    ? "https"
    : "http";
};

/** Marshal a Node request into the Web `Request` the gateway consumes. */
export const toWebRequest = (
  req: NodeLikeRequest,
  signal: AbortSignal
): Request => {
  const base = `${requestProtocol(req)}://${req.headers.host ?? "localhost"}`;
  const url = new URL(req.originalUrl ?? req.url ?? "/", base);

  // `rawHeaders` is a flat [k, v, k, v, …] list — appending each pair preserves
  // duplicates without the string|string[] branching of `req.headers`.
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { headers, method, signal };
  if (hasBody) {
    init.body = toWebStream(req);
    init.duplex = "half";
  }
  return new Request(url, init);
};

/** Flush a Web `Response` (status, headers, streamed body) onto the Node response. */
export const sendWebResponse = async (
  res: ServerResponse,
  response: Response
): Promise<void> => {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    res.setHeader(key, value);
  }
  if (response.body) {
    await pipeline(toNodeReadable(response.body), res);
  } else {
    res.end();
  }
};

/**
 * An `AbortSignal` that fires when the client disconnects before the response
 * finishes — for bindings that return the `Response` to the framework to flush
 * (e.g. Nitro), so there is no `ServerResponse` here to guard `writableFinished`
 * on. The connection socket's `close` is the one disconnect event that fires
 * across Node and Bun; once the response is fully sent the socket closes too,
 * but aborting then is a harmless no-op for an already-settled request.
 */
export const abortSignalForNodeRequest = (
  req: IncomingMessage
): AbortSignal => {
  const controller = new AbortController();
  req.socket?.once("close", () => controller.abort());
  return controller.signal;
};

/**
 * Run the gateway against a Node request/response pair: marshal the request,
 * dispatch, and flush the response, wiring a client disconnect through to the
 * upstream read. This is the whole binding for `express`/`koa`/`fastify` — each
 * only has to hand over its underlying `(req, res)`.
 */
export const handleNodeRequest = async (
  router: FilesApi,
  req: NodeLikeRequest,
  res: ServerResponse
): Promise<void> => {
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
    const response = await router.handle(toWebRequest(req, controller.signal));
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
