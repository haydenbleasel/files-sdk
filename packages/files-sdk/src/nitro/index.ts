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
// (a node-compat shim on edge, which Nitro polyfills via unenv).

import type { H3Event } from "h3";

import type { FilesApi } from "../api/index.js";
import {
  abortSignalForNodeRequest,
  toWebRequest,
} from "../internal/node-http.js";

export type NitroRouteHandler = (event: H3Event) => Promise<Response>;

export const createRouteHandler =
  (router: FilesApi): NitroRouteHandler =>
  (event) =>
    router.handle(
      toWebRequest(event.node.req, abortSignalForNodeRequest(event.node.req))
    );
