// `files-sdk/nitro` — mount a `createFilesRouter` (or any `{ handle }`) in a
// Nitro (or Nuxt server) route. Nitro's h3 event carries the Node request as
// `event.node.req`, so this marshals it into the Web `Request` the gateway speaks
// (the shared `toWebRequest` from `internal/node-http.ts`) and returns the Web
// `Response` for Nitro to flush — hiding the `toWebRequest(event)` step a hand
// binding would spell out. A client disconnect aborts the upstream read on a
// proxied download.
//
//   // routes/api/files.ts (Nitro) — server/routes/api/files.ts (Nuxt)
//   export default defineEventHandler(createRouteHandler(router));
//
// The gateway dispatches by method internally (GET = download, POST = the JSON
// verbs, PUT = the upload byte path), so a single event handler serves them all.
// Targets Nitro v2 / h3 v1, where `event.node.req` is present on every preset
// (a node-compat shim on edge, which Nitro polyfills via unenv). When the event
// already carries a Web `Request` (h3's `toWebHandler`), that is used as-is; a
// request Nitro serves in-process (the edge preset's `localFetch`, an SSR
// `$fetch` to its own API) is a `node-mock-http` stand-in with no socket to
// stream from, so its body is read from where h3 keeps it instead.

import type { H3Event } from "h3";

import type { FilesApi } from "../api/index.js";
import { isFunction, isObject, isString } from "../internal/is.js";
import {
  abortSignalForNodeRequest,
  toWebRequest,
} from "../internal/node-http.js";
import { toWebStream } from "../internal/node-stream.js";

export type NitroRouteHandler = (event: H3Event) => Promise<Response>;

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
const inProcessBody = (event: H3Event): BodyInit | null => {
  const { req } = event.node;
  let raw: unknown = event._requestBody;
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
const isInProcess = (event: H3Event): boolean => {
  const { req } = event.node;
  return (
    event._requestBody !== undefined ||
    "__unenv__" in req ||
    "rawBody" in req ||
    "body" in req ||
    !(isObject(req.socket) && isFunction(req.socket.once))
  );
};

export const createRouteHandler =
  (router: FilesApi): NitroRouteHandler =>
  (event) => {
    const webRequest = event.web?.request;
    if (webRequest) {
      return router.handle(webRequest);
    }
    const { req, res } = event.node;
    const signal = abortSignalForNodeRequest(req, res);
    return router.handle(
      isInProcess(event)
        ? toWebRequest(req, signal, { body: inProcessBody(event) })
        : toWebRequest(req, signal)
    );
  };
