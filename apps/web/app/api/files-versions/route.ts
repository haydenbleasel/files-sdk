import { createFiles } from "files-sdk";
import { createFilesRouter } from "files-sdk/api";
import { memory } from "files-sdk/memory";
import { createRouteHandler } from "files-sdk/next";
import { versioning } from "files-sdk/versioning";

import { resolveFilesApiSecret } from "../files-secret";

// A dedicated in-memory instance wrapped with `versioning()`, so the Version
// History component docs render against real saved snapshots. It's separate from
// `/api/files` because `versioning()` and `softDelete()` both graft a `restore`
// method — keeping them on different gateways lets each component's restore work.
const files = createFiles({ adapter: memory(), plugins: [versioning()] });
const DEMO_MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const router = createFilesRouter({
  authorize: () => ({ keyPrefix: "demo/" }),
  files,
  maxUploadSize: DEMO_MAX_UPLOAD_SIZE,
  secret: resolveFilesApiSecret(),
});

// A short edit history for `demo/notes.txt`: each successive upload snapshots the
// previous bytes, so the component lists one version per prior revision (4 writes
// → 3 versions). Distinct content gives each a distinct size + ETag.
const REVISIONS = [
  "# Notes\n\nFirst rough draft.",
  "# Notes\n\nFirst rough draft.\n\n- Added an outline.",
  "# Notes\n\nSecond draft — tighter intro.\n\n- Outline\n- Trimmed the intro.",
  "# Notes\n\nProofread and ready.\n\n- Outline\n- Tighter intro\n- Proofread the body copy.",
];

let seedPromise: Promise<unknown> | undefined;
const ensureSeeded = async (): Promise<void> => {
  seedPromise ??= (async () => {
    for (const body of REVISIONS) {
      await files.upload("demo/notes.txt", body, {
        contentType: "text/markdown",
      });
    }
  })();
  await seedPromise;
};

const handlers = createRouteHandler(router);
const gate =
  (handler: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    await ensureSeeded();
    return handler(request);
  };

export const GET = gate(handlers.GET);
export const POST = gate(handlers.POST);
export const PUT = gate(handlers.PUT);
