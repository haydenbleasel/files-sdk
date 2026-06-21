// `files-sdk/hono` — mount a `createFilesRouter` (or any `{ handle }`) in a Hono
// app. Like `files-sdk/next`, the gateway is Web-native (`Request`/`Response`,
// `crypto.subtle`, `ReadableStream`), so a binding is a one-liner that forwards
// the underlying `Request` and runs unchanged on Workers, Bun, Deno, and Node.
//
//   import { Hono } from "hono";
//   const app = new Hono();
//   app.all("/api/files", createRouteHandler(router));
//
// The gateway dispatches by method internally (GET = download, POST = the JSON
// verbs, PUT = the upload byte path), so register all three with `app.all`.

import type { Context } from "hono";

import type { FilesApi } from "../api/index.js";

export type HonoRouteHandler = (c: Context) => Promise<Response>;

export const createRouteHandler =
  (router: FilesApi): HonoRouteHandler =>
  (c) =>
    router.handle(c.req.raw);
