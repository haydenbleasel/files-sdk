// Landing-page capability cards. Extracted from the original React section so
// pages/index.astro can pre-highlight the code at build time and map each
// `panel` key to its animated island component.

export interface Capability {
  title: string;
  description: string;
  docHref: string;
  code: string;
  lang?: string;
  panel: string;
}

export const CAPABILITIES: Capability[] = [
  {
    code: `await files.upload("report.pdf", body);
const file = await files.download("report.pdf");

await files.copy("a.png", "b.png");
await files.move("tmp/x.png", "img/x.png");

// walk every page as a plain async iterable
for await (const f of files.listAll({ prefix: "img/" })) {
  console.log(f.key, f.size);
}

// pass an array to batch with bounded concurrency
await files.delete(["old/1.png", "old/2.png"]);`,
    description:
      "upload, download, head, exists, copy, move, list, delete — the same calls on every adapter. Hand any of them an array to batch with bounded concurrency, or walk a listing as a plain async iterable.",
    docHref: "/docs/api",
    panel: "methods",
    title: "Every operation, one interface",
  },
  {
    code: `// glob by default — ** spans folders
for await (const file of files.search("invoices/**/*.pdf")) {
  console.log(file.key, file.size);
}

// or a regex, substring, or exact match
const errors = files.search(/error|panic/, { prefix: "logs/" });

// collect into an array, capped
const recent = await Array.fromAsync(
  files.search("*.png", { maxResults: 20 }),
);`,
    description:
      "files.search() finds objects by key — a glob by default, or a regex, substring, or exact match. Matches stream back as an async iterable, and a glob's prefix scopes the walk to skip the rest of the bucket.",
    docHref: "/docs/api/search",
    panel: "search",
    title: "Find files by name, glob, or regex",
  },
  {
    code: `import { createFileTools } from "files-sdk/ai-sdk";
import { generateText } from "ai";

const tools = createFileTools({
  files,
  requireApproval: { deleteFile: true },
});

await generateText({
  model,
  tools, // listFiles, downloadFile, uploadFile, …
  prompt: "Archive last month's invoices to /archive.",
});`,
    description:
      "Generate ready-made file tools for the Vercel AI SDK, OpenAI Agents, or Claude and MCP. Hand your agent list, read, upload, and delete — with read-only mode and per-tool approval gates built in.",
    docHref: "/docs/ai/vercel",
    panel: "ai-tools",
    title: "File tools for your agents",
  },
  {
    code: `# upload from a pipe, switch providers with a flag
cat q1.pdf | files --provider s3 upload q1.pdf --stdin

# list as JSON — the default
files --provider r2 list --prefix reports/

# stream a download straight to disk
files --provider gcs download q1.pdf --stdout > out.pdf`,
    description:
      "Every method is also a command. Stream with stdin and stdout, switch backends with --provider, and get JSON by default — handy for scripts, CI, and one-off ops.",
    docHref: "/docs/cli",
    lang: "bash",
    panel: "cli",
    title: "The same SDK, from your shell",
  },
  {
    code: `// split a large body into parallel parts
await files.upload("db.tar", stream, {
  multipart: true,
});

// or tune the part size & concurrency
await files.upload("db.tar", stream, {
  multipart: {
    partSize: 16 * 1024 * 1024,
    concurrency: 4,
  },
});`,
    description:
      "Hand off a large body or an unbounded stream and files-sdk splits it into parts, uploading them with bounded concurrency. Tune the part size and parallelism, or just say multipart: true.",
    docHref: "/docs/multipart",
    panel: "multipart",
    title: "Multipart, in parallel",
  },
  {
    code: `const items = [
  { key: "hero.jpg", body: hero },
  { key: "promo.mp4", body: promo },
  // …two more
];

await files.upload(items, {
  onProgress({ key, loaded, total }) {
    bars.get(key)?.set(loaded / total);
  },
});`,
    description:
      "Pass one callback and get byte-level progress for every file — buffered or streamed, single or bulk. Drive a progress bar per key without ever touching the transport.",
    docHref: "/docs/api/onprogress",
    panel: "upload-progress",
    title: "Live upload progress",
  },
  {
    code: `// download just a byte range — end is inclusive
const head = await files.download("video.mp4", {
  range: { start: 0, end: 1023 },
});

// stream the next chunk as the player seeks
const chunk = await files.download("video.mp4", {
  as: "stream",
  range: { start: offset, end: offset + CHUNK },
});`,
    description:
      "Ask for exactly the bytes you need. Ranged reads map straight to HTTP 206, so you can seek video, resume a download, or read a file header without pulling the whole object.",
    docHref: "/docs/api/download",
    panel: "byte-range",
    title: "Byte-range downloads",
  },
  {
    code: `const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  hooks: {
    onAction({ type, status, durationMs }) {
      metrics.timing("files." + type, durationMs);
    },
    onRetry({ type, attempt }) {
      log.warn("retry " + attempt + ": " + type);
    },
    onError({ error }) {
      if (!error.aborted) Sentry.captureException(error);
    },
  },
});`,
    description:
      "Wire metrics, logging, and error reporting once at the constructor. onAction, onRetry, and onError fire for every operation across every adapter — fire-and-forget, never in your way.",
    docHref: "/docs/api/onaction",
    panel: "lifecycle-hooks",
    title: "Lifecycle hooks",
  },
  {
    code: `const live = new Files({ adapter: s3({ bucket: "live" }) });
const backup = new Files({
  adapter: r2({
    bucket: "backup",
    accountId,
    accessKeyId,
    secretAccessKey,
  }),
});

// back up S3 to R2 — only the delta moves
const {
  uploaded,
  skipped,
  deleted,
} = await sync(live, backup, {
  prune: true,
  compare: "size",
});`,
    description:
      "sync() reconciles one backend onto another — uploading only what changed, skipping what's identical, and pruning what's gone. Back up or migrate in a line, and dry-run the plan first.",
    docHref: "/docs/api/sync",
    panel: "sync",
    title: "Mirror across backends",
  },
];
