// Plain source strings for the 2.0 tabbed editor. Thanks to the shared
// tokenizer (`shared/highlight.ts`) these can be authored as real code rather
// than hand-tagged token tuples. Line indices below are referenced by the
// editor to spotlight the "client hook" and "add shadcn components" beats.

export const PAGE_FILE = "app/page.tsx";
export const ROUTE_FILE = "app/api/files/route.ts";
export const PREVIEW_TAB = "Preview";

export const TAB_FILES = [PAGE_FILE, ROUTE_FILE, PREVIEW_TAB] as const;

export const PAGE_CODE = `"use client";

import { useFiles } from "files-sdk/react"; // or files-sdk/svelte, files-sdk/vue
import { Dropzone, DropzoneContent, DropzoneEmptyState } from "@/components/files-sdk/dropzone";
import { FileList } from "@/components/files-sdk/file-list";
import { UploadProgress } from "@/components/files-sdk/upload-progress";

export default function Page() {
  const files = useFiles({ endpoint: "/api/files" });

  return (
    <main>
      <Dropzone files={files} accept="image/*" maxFiles={10}>
        <DropzoneEmptyState />
        <DropzoneContent />
      </Dropzone>
      <UploadProgress files={files} />
      <FileList files={files} />
    </main>
  );
}`;

export const ROUTE_CODE = `import { createFiles } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createFilesRouter } from "files-sdk/api";
import { createRouteHandler } from "files-sdk/next"; // or hono, express, astro, bun, etc.

const router = createFilesRouter({
  files: createFiles({ adapter: s3({ bucket: "uploads" }) }),
  authorize: async ({ req }) => {
    const session = await auth(req);
    return { keyPrefix: \`users/\${session.id}/\` };
  },
});

export const { GET, POST, PUT } = createRouteHandler(router);`;

/** The `const files = useFiles(...)` line — spotlit during the "hook" beat. */
export const HOOK_LINE = 8;

/** First JSX line using a shadcn component — triggers the "shadcn" beat + toast. */
export const SHADCN_FIRST_LINE = 12;

/** The shadcn component JSX usage — spotlit during the "add shadcn" beat. */
export const SHADCN_LINES = [12, 13, 14, 15, 16, 17] as const;
