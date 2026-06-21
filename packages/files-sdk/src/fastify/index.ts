// `files-sdk/fastify` — mount a `createFilesRouter` (or any `{ handle }`) on a
// Fastify server. Fastify hands you Node `IncomingMessage`/`ServerResponse` under
// `request.raw`/`reply.raw`, so this reuses the shared Node bridge
// (`internal/node-http.ts`) the `express` binding uses. `reply.hijack()` tells
// Fastify to stop managing the response — the gateway writes `reply.raw` directly
// (status, headers, streamed body), and a client disconnect aborts the upstream
// read on a proxied download.
//
//   import Fastify from "fastify";
//   const app = Fastify();
//   // Don't let Fastify consume the body — the gateway reads the raw stream:
//   app.addContentTypeParser("*", (_req, _payload, done) => done(null));
//   app.all("/api/files", createRouteHandler(router));
//
// IMPORTANT: Fastify runs its content-type parsers BEFORE the handler, and the
// default parsers consume the request body the gateway needs (the JSON verbs and
// the proxy/explicit-key PUT upload both read the raw bytes). Register a no-op
// catch-all parser as above (scope it to an encapsulated plugin if you don't want
// it app-wide) so the body reaches the gateway untouched.

import type { FastifyReply, FastifyRequest } from "fastify";

import type { FilesApi } from "../api/index.js";
import { handleNodeRequest } from "../internal/node-http.js";

export type FastifyRouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void>;

export const createRouteHandler =
  (router: FilesApi): FastifyRouteHandler =>
  async (request, reply) => {
    // Take over the raw response so Fastify doesn't try to serialize ours.
    reply.hijack();
    await handleNodeRequest(router, request.raw, reply.raw);
  };
