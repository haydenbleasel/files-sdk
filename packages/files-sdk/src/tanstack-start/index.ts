// `files-sdk/tanstack-start` — mount a `createFilesRouter` (or any `{ handle }`)
// in a TanStack Start server route. TanStack Start hands each method handler a
// Web `Request` on `{ request }` and wants a `{ GET, POST, PUT }` handlers object
// (under `server.handlers`), so — like `files-sdk/next` — `createRouteHandler`
// returns that object: `GET` serves downloads, `POST` the JSON verbs, and `PUT`
// the upload byte path. The handlers are Web-native, so the route runs on every
// TanStack Start deployment target. The same object also slots into the older
// `createServerFileRoute().methods(...)` form.
//
//   // src/routes/api/files.ts
//   import { createFileRoute } from "@tanstack/react-router";
//   export const Route = createFileRoute("/api/files")({
//     server: { handlers: createRouteHandler(router) },
//   });

import type { FilesApi } from "../api/index.js";

export type TanStackStartRouteHandler = (ctx: {
  request: Request;
}) => Promise<Response>;

export interface TanStackStartRouteHandlers {
  GET: TanStackStartRouteHandler;
  POST: TanStackStartRouteHandler;
  PUT: TanStackStartRouteHandler;
}

export const createRouteHandler = (
  router: FilesApi
): TanStackStartRouteHandlers => ({
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  GET: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  POST: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  PUT: ({ request }) => router.handle(request),
});
