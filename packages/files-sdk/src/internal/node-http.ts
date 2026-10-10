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
import { isFunction, isObject, isString } from "./is.js";
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

/**
 * Marshal a Node request into the Web `Request` the gateway consumes.
 *
 * `body` overrides the request stream: pass it when the payload doesn't live on
 * `req` as a readable stream (an in-process mock request carries it on a
 * property instead); `null` sends no body. `url` overrides the request path
 * (e.g. Koa's `ctx.originalUrl` under a mount).
 */
export const toWebRequest = (
  req: NodeLikeRequest,
  signal: AbortSignal,
  overrides: { body?: BodyInit | null; url?: string } = {}
): Request => {
  // HTTP/2 (`node:http2`'s compat API, Fastify's `http2: true`) carries the
  // host in the `:authority` pseudo-header and may send no `Host` at all.
  const authority = req.headers[":authority"];
  const host =
    req.headers.host ?? (isString(authority) ? authority : undefined);
  const base = `${requestProtocol(req)}://${host ?? "localhost"}`;
  const url = new URL(overrides.url ?? req.originalUrl ?? req.url ?? "/", base);

  // `rawHeaders` is a flat [k, v, k, v, …] list — appending each pair preserves
  // duplicates without the string|string[] branching of `req.headers`.
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    // HTTP/2 pseudo-headers (`:method`, `:path`, `:authority`, `:scheme`)
    // aren't valid header names, so `Headers` would throw on them; what they
    // carry is already on the URL and method.
    if (name !== undefined && value !== undefined && !name.startsWith(":")) {
      headers.append(name, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { headers, method, signal };
  if (hasBody && overrides.body !== null) {
    init.body = overrides.body ?? toWebStream(req);
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
 * (e.g. Nitro). The connection socket's `close` is the one disconnect event
 * that fires across Node and Bun; `res`'s own `close` covers runtimes that
 * report the disconnect there first. Both listeners come off once `res`
 * finishes or closes, so a keep-alive socket serving many requests doesn't
 * accumulate one per request. A socket without an event API (an in-process
 * mock request) yields a signal that never aborts.
 */
export const abortSignalForNodeRequest = (
  req: IncomingMessage,
  res: ServerResponse
): AbortSignal => {
  const controller = new AbortController();
  const { socket } = req;
  if (!(isObject(socket) && isFunction(socket.once))) {
    return controller.signal;
  }
  const listeners = {
    abortUnlessFinished: (): void => {
      if (!res.writableFinished) {
        controller.abort();
      }
      listeners.detach();
    },
    detach: (): void => {
      socket.removeListener("close", listeners.abortUnlessFinished);
      res.removeListener("close", listeners.abortUnlessFinished);
      res.removeListener("finish", listeners.detach);
    },
  };
  const { abortUnlessFinished, detach } = listeners;
  socket.once("close", abortUnlessFinished);
  res.once("close", abortUnlessFinished);
  res.once("finish", detach);
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
  res: ServerResponse,
  overrides: { url?: string } = {}
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
    const response = await router.handle(
      toWebRequest(req, controller.signal, overrides)
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
