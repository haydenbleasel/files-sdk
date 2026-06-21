import { createFiles } from "files-sdk";
import { createFilesRouter } from "files-sdk/api";
import { memory } from "files-sdk/memory";
import { createRouteHandler } from "files-sdk/next";

// A single in-memory `Files` instance shared across requests for the duration of
// the dev server. A real app would point this at S3/R2/GCS/etc. and persist.
const files = createFiles({ adapter: memory() });

// The gateway exposes the whole Files API to the browser over this one endpoint.
// `authorize` is the per-operation gate: here it allows every verb but scopes
// every key under `demo/`, so the browser can never address outside that prefix.
// A production app would authenticate the request and return a per-user prefix
// (and throw to deny writes for read-only sessions).
const router = createFilesRouter({
  authorize: () => ({ keyPrefix: "demo/" }),
  files,
  secret: process.env.FILES_API_SECRET ?? "demo-secret-change-in-production",
});

export const { GET, POST, PUT } = createRouteHandler(router);
