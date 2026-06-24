import { createFiles } from "files-sdk";
import { createFilesRouter } from "files-sdk/api";
import { memory } from "files-sdk/memory";
import { createRouteHandler } from "files-sdk/next";
import { softDelete } from "files-sdk/soft-delete";

import { resolveFilesApiSecret } from "../files-secret";

// A dedicated in-memory instance wrapped with `softDelete()`, so the Trash Bin
// component docs render against real trashed objects. Separate from `/api/files`
// because `softDelete()` and `versioning()` both graft a `restore` method —
// keeping them apart lets each component's restore work correctly.
const files = createFiles({ adapter: memory(), plugins: [softDelete()] });
const DEMO_MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const router = createFilesRouter({
  authorize: () => ({ keyPrefix: "demo/" }),
  files,
  maxUploadSize: DEMO_MAX_UPLOAD_SIZE,
  secret: resolveFilesApiSecret(),
});

// A handful of files uploaded then soft-deleted, so they show up in the trash
// with varying sizes. A soft delete relocates the object into the trash prefix;
// the component lists them by their original key.
const TRASHED: { key: string; body: string; type: string }[] = [
  {
    body: "An early outline that didn't make the cut.",
    key: "demo/old-draft.md",
    type: "text/markdown",
  },
  {
    body: "id,name,amount\n1,Acme,1200\n2,Globex,980\n3,Initech,640\n",
    key: "demo/exports/q1-report.csv",
    type: "text/csv",
  },
  {
    body: "TODO: replace this placeholder screenshot.",
    key: "demo/screenshot.png",
    type: "text/plain",
  },
];

let seedPromise: Promise<unknown> | undefined;
const ensureSeeded = async (): Promise<void> => {
  seedPromise ??= (async () => {
    for (const item of TRASHED) {
      await files.upload(item.key, item.body, { contentType: item.type });
      await files.delete(item.key);
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
