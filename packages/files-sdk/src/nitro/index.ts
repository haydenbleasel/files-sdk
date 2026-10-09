// `files-sdk/nitro` — mount a `createFilesRouter` (or any `{ handle }`) in a
// Nitro (or Nuxt server) route and return the Web `Response` for Nitro to
// flush. A client disconnect aborts the upstream read on a proxied download.
//
//   // Nitro 3 / h3 2: routes/api/files.ts
//   export default defineHandler(createRouteHandler(router));
//   // Nitro 2 / h3 1: routes/api/files.ts (Nuxt: server/routes/api/files.ts)
//   export default defineEventHandler(createRouteHandler(router));
//
// The gateway dispatches by method internally (GET = download, POST = the JSON
// verbs, PUT = the upload byte path), so a single event handler serves them all.
//
// h3 2 hands every runtime a Web `Request` on `event.req`, used as-is (its
// signal already aborts on disconnect). h3 1 carries the Node request as
// `event.node.req` on every preset (a node-compat shim on edge, which Nitro
// polyfills via unenv), so it's marshalled with the shared `toWebRequest` from
// `internal/node-http.ts` — unless the event already carries a Web `Request`
// (h3 1's `toWebHandler`). A request h3 1 serves in-process (the edge preset's
// `localFetch`, an SSR `$fetch` to its own API) is a `node-mock-http` stand-in
// with no socket to stream from, so its body is read from where h3 keeps it.
//
// Nothing here imports `h3`, not even its types: `NitroEvent` is the slice of
// an event the binding reads, which both majors' `H3Event` satisfy, and an app
// on Nitro 3 may only reach h3 through `nitro/h3`.

import type { ServerResponse } from "node:http";

import type { FilesApi } from "../api/index.js";
import { FilesError } from "../internal/errors.js";
import { isFunction, isObject, isString } from "../internal/is.js";
import {
  abortSignalForNodeRequest,
  toWebRequest,
} from "../internal/node-http.js";
import type { NodeLikeRequest } from "../internal/node-http.js";
import { toWebStream } from "../internal/node-stream.js";

/** The parts of an h3 event the binding reads; h3 1's and h3 2's `H3Event` both fit. */
export interface NitroEvent {
  /** h3 2: the Web `Request`. h3 1: a deprecated alias of the Node request. */
  readonly req?: unknown;
  /** h3 1: the Node request and response. h3 2: a deprecated getter, Node only. */
  readonly node?: { readonly req: unknown; readonly res?: unknown } | undefined;
  /** h3 1 under `toWebHandler`: the Web `Request` it was called with. */
  readonly web?: { readonly request?: Request | undefined } | undefined;
  /** h3 1: the body of an in-process request. */
  readonly _requestBody?: BodyInit | undefined;
}

export type NitroRouteHandler = (event: NitroEvent) => Promise<Response>;

// Structural rather than `instanceof`: h3 1's `event.req` is a Node request
// (plain-object headers), and a `Request` from another realm (a Vite
// environment runner, workerd) must still count.
const isWebRequest = (value: unknown): value is Request =>
  isObject(value) &&
  "arrayBuffer" in value &&
  isFunction(value.arrayBuffer) &&
  "headers" in value &&
  isObject(value.headers) &&
  "get" in value.headers &&
  isFunction(value.headers.get);

const isBodyInit = (value: unknown): value is BodyInit =>
  isString(value) ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  value instanceof Blob ||
  value instanceof ReadableStream ||
  value instanceof URLSearchParams ||
  value instanceof FormData;

// The payload of an in-process request, mirroring h3's own `readRawBody`
// lookup: the event's web body, then the mock request's `rawBody`/`body`. A
// plain object (a pre-parsed JSON body) is re-serialized, a Node stream is
// bridged, and nothing at all means an empty body.
const inProcessBody = (
  req: NodeLikeRequest,
  requestBody: BodyInit | undefined
): BodyInit | null => {
  let raw: unknown = requestBody;
  if (raw === undefined && "rawBody" in req) {
    raw = req.rawBody;
  }
  if (raw === undefined && "body" in req) {
    raw = req.body;
  }
  if (raw === undefined || raw === null) {
    return null;
  }
  if (isBodyInit(raw)) {
    return raw;
  }
  if (isObject(raw) && "pipe" in raw && isFunction(raw.pipe)) {
    // SAFETY: an object with a `pipe` method on a Node request is a Node
    // `Readable` (a body a middleware re-attached as a stream).
    return toWebStream(raw as Parameters<typeof toWebStream>[0]);
  }
  return isObject(raw) ? JSON.stringify(raw) : String(raw);
};

// node-mock-http requests have a socket with no event API and keep their
// payload on a property (h3 checks the same markers in `getRequestWebStream`).
const isInProcess = (
  req: NodeLikeRequest,
  requestBody: BodyInit | undefined
): boolean =>
  requestBody !== undefined ||
  "__unenv__" in req ||
  "rawBody" in req ||
  "body" in req ||
  !(isObject(req.socket) && isFunction(req.socket.once));

export const createRouteHandler =
  (router: FilesApi): NitroRouteHandler =>
  (event) => {
    // h3 2 first: h3 1 also has an `event.req`, but it's the Node request.
    if (isWebRequest(event.req)) {
      return router.handle(event.req);
    }
    const webRequest = event.web?.request;
    if (webRequest) {
      return router.handle(webRequest);
    }
    const { node } = event;
    if (!(node && isObject(node.req) && isObject(node.res))) {
      return Promise.reject(
        new FilesError(
          "Provider",
          "files-sdk/nitro: the event carries neither a Web Request (h3 2) nor a Node request and response (h3 1)."
        )
      );
    }
    // SAFETY: with no Web Request on the event this is h3 1, whose
    // `event.node` is always the IncomingMessage / ServerResponse pair.
    const req = node.req as NodeLikeRequest;
    // SAFETY: as above, h3 1's `event.node.res` is the ServerResponse.
    const res = node.res as ServerResponse;
    const signal = abortSignalForNodeRequest(req, res);
    const requestBody = event._requestBody;
    return router.handle(
      isInProcess(req, requestBody)
        ? toWebRequest(req, signal, {
            body: inProcessBody(req, requestBody),
          })
        : toWebRequest(req, signal)
    );
  };
