// `files-sdk/sveltekit` — mount a `createFilesRouter` (or any `{ handle }`) in a
// SvelteKit `+server.ts` endpoint. SvelteKit hands each route a Web `Request` on
// `event.request` and wants named per-method exports, so — like `files-sdk/next`
// — `createRouteHandler` returns `{ GET, POST, PUT }` you re-export: `GET` serves
// downloads, `POST` the JSON verbs, and `PUT` the upload byte path. The handlers
// are Web-native, so the route runs on the Node and edge adapters alike. (This is
// the server binding — distinct from the `files-sdk/svelte` client store.)
//
//   // src/routes/api/files/+server.ts
//   export const { GET, POST, PUT } = createRouteHandler(router);

import type { RequestHandler } from "@sveltejs/kit";

import type { FilesApi } from "../api/index.js";

export interface SvelteKitRouteHandlers {
  GET: RequestHandler;
  POST: RequestHandler;
  PUT: RequestHandler;
}

export const createRouteHandler = (
  router: FilesApi
): SvelteKitRouteHandlers => ({
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  GET: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  POST: ({ request }) => router.handle(request),
  // oxlint-disable-next-line sonarjs/function-name -- framework requires this exact handler export name
  PUT: ({ request }) => router.handle(request),
});
