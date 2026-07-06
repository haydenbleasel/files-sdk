// `files-sdk/astro` — mount a `createFilesRouter` (or any `{ handle }`) in an
// Astro endpoint. Astro hands each route a Web `Request` on `context.request` and
// wants named per-method exports, so — like `files-sdk/next` — `createRouteHandler`
// returns `{ GET, POST, PUT }` you re-export: `GET` serves downloads, `POST` the
// JSON verbs, and `PUT` the upload byte path. The handlers are Web-native, so the
// route runs on Node and edge adapters alike.
//
//   // src/pages/api/files.ts
//   export const prerender = false;
//   export const { GET, POST, PUT } = createRouteHandler(router);
//
// The endpoint must run per-request, so it needs server-side rendering: set
// `prerender = false` on the route (or `output: "server"`) and an SSR adapter.

import type { APIRoute } from "astro";

import type { FilesApi } from "../api/index.js";

export interface AstroRouteHandlers {
  GET: APIRoute;
  POST: APIRoute;
  PUT: APIRoute;
}

export const createRouteHandler = (router: FilesApi): AstroRouteHandlers => ({
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  GET: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  POST: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  PUT: ({ request }) => router.handle(request),
});
