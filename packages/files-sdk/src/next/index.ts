// `files-sdk/next` — mount a `createFilesRouter` (or any `{ handle }`) in the
// Next.js App Router. The gateway is Web-native (`Request`/`Response`,
// `crypto.subtle`, `ReadableStream`), so the same handler runs on Node and Edge.
// GET serves `download`; POST serves the JSON verbs; PUT serves the
// proxy/explicit-key upload byte path.

import type { FilesApi } from "../api/index.js";

export interface NextRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
  PUT: (req: Request) => Promise<Response>;
}

export const createRouteHandler = (router: FilesApi): NextRouteHandlers => ({
  GET: (req) => router.handle(req),
  POST: (req) => router.handle(req),
  PUT: (req) => router.handle(req),
});
