// `files-sdk/express` — mount a `createFilesRouter` (or any `{ handle }`) on a
// Node server. Unlike the Web-native bindings, Express/Connect/`node:http` hand
// you a Node `IncomingMessage`/`ServerResponse` pair, so this bridges them to
// the Web `Request`/`Response` the gateway speaks (`Readable.toWeb`/`fromWeb` +
// `pipeline`, the same seam the CLI uses). It is typed against `node:http`, so it
// works with Express, Connect, and a raw `http.createServer` alike. The bridge
// itself lives in `internal/node-http.ts`, shared with `koa`/`fastify`/`nitro`.
//
//   import express from "express";
//   const app = express();
//   app.all("/api/files", createRouteHandler(router));
//
// IMPORTANT: mount this BEFORE any body parser (`express.json()` / `urlencoded`),
// or scope the parser to exclude this route. A body parser consumes the request
// stream — the gateway must read the raw bytes itself (the JSON verbs and the
// proxy/explicit-key PUT upload both need the untouched body).

import type { ServerResponse } from "node:http";

import type { FilesApi } from "../api/index.js";
import { handleNodeRequest } from "../internal/node-http.js";
import type { NodeLikeRequest } from "../internal/node-http.js";

/** A Node request, optionally carrying Express's `originalUrl` (the pre-mount path). */
export type ExpressLikeRequest = NodeLikeRequest;

export type ExpressRouteHandler = (
  req: ExpressLikeRequest,
  res: ServerResponse
) => Promise<void>;

export const createRouteHandler =
  (router: FilesApi): ExpressRouteHandler =>
  (req, res) =>
    handleNodeRequest(router, req, res);
