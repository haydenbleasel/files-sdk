// `files-sdk/koa` — mount a `createFilesRouter` (or any `{ handle }`) on a Koa
// app. Koa wraps the Node `IncomingMessage`/`ServerResponse` as `ctx.req`/
// `ctx.res`, so this reuses the shared Node bridge (`internal/node-http.ts`) the
// `express` binding uses. Setting `ctx.respond = false` tells Koa to step back
// and let the gateway write `ctx.res` directly (status, headers, streamed body);
// a client disconnect aborts the upstream read on a proxied download.
//
//   import Koa from "koa";
//   const app = new Koa();
//   app.use(async (ctx, next) => {
//     if (ctx.path === "/api/files") return createRouteHandler(router)(ctx);
//     await next();
//   });
//
// IMPORTANT: mount this BEFORE any body parser (`koa-bodyparser`, …), or scope
// the parser to exclude this route. A body parser consumes the request stream —
// the gateway must read the raw bytes itself (the JSON verbs and the proxy/
// explicit-key PUT upload both need the untouched body).

import type { Context } from "koa";

import type { FilesApi } from "../api/index.js";
import { handleNodeRequest } from "../internal/node-http.js";

export type KoaRouteHandler = (ctx: Context) => Promise<void>;

export const createRouteHandler =
  (router: FilesApi): KoaRouteHandler =>
  async (ctx) => {
    // Cede Koa's response handling — the gateway writes the raw response itself.
    ctx.respond = false;
    await handleNodeRequest(router, ctx.req, ctx.res);
  };
