import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AiTools } from "@/components/capabilities/ai-tools";
import { ByteRange } from "@/components/capabilities/byte-range";
import { Cli } from "@/components/capabilities/cli";
import { LifecycleHooks } from "@/components/capabilities/lifecycle-hooks";
import { Methods } from "@/components/capabilities/methods";
import { Multipart } from "@/components/capabilities/multipart";
import { UploadProgress } from "@/components/capabilities/upload-progress";
import { CodeBlock } from "@/components/code-block";
import { FadeIn } from "@/components/fade-in";

interface Capability {
  title: string;
  description: string;
  docHref: string;
  code: string;
  lang?: string;
  panel?: ReactNode;
}

// Strips the code block's default chrome so it blends into the shared card.
const BARE_CODE = "my-0 rounded-none border-0 bg-transparent shadow-none";

const CAPABILITIES: Capability[] = [
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
    docHref: "/api",
    panel: <Methods />,
    title: "Every operation, one interface",
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
    docHref: "/ai/vercel",
    panel: <AiTools />,
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
    docHref: "/cli",
    lang: "bash",
    panel: <Cli />,
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
    docHref: "/features/multipart",
    panel: <Multipart />,
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
    docHref: "/features/onprogress",
    panel: <UploadProgress />,
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
    docHref: "/api/download",
    panel: <ByteRange />,
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
    docHref: "/features/onaction",
    panel: <LifecycleHooks />,
    title: "Lifecycle hooks",
  },
];

export const Capabilities = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24">
      <div>
        <p className="font-mono text-xs text-muted-foreground">Capabilities</p>
        <h2 className="mt-3 max-w-[30ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
          Everything you do with files.
        </h2>
        <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          A complete set of operations, 40+ adapters behind one interface,
          ready-made AI tools, and a CLI — plus multipart, live progress, byte
          ranges, and lifecycle hooks. The same one-line ergonomics on every
          backend.
        </p>
      </div>

      <div className="mt-20 flex flex-col gap-24 sm:gap-28">
        {CAPABILITIES.map((capability) => (
          <FadeIn key={capability.title}>
            <div>
              <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-2xl font-medium tracking-tight text-balance text-foreground sm:text-3xl">
                    {capability.title}
                  </h3>
                  <p className="mt-4 max-w-[60ch] text-base leading-relaxed text-pretty text-muted-foreground">
                    {capability.description}
                  </p>
                </div>
                <Link
                  className="group inline-flex items-center gap-1.5 self-start text-sm font-medium text-foreground underline-offset-4 hover:underline sm:justify-self-end"
                  href={capability.docHref}
                >
                  Read the docs
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>

              {capability.panel ? (
                <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
                  <div className="grid lg:grid-cols-2">
                    <CodeBlock
                      className={BARE_CODE}
                      code={capability.code}
                      lang={capability.lang ?? "tsx"}
                    />
                    <div className="border-t border-border lg:border-t-0 lg:border-l">
                      {capability.panel}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card lg:max-w-2xl">
                  <CodeBlock
                    className={BARE_CODE}
                    code={capability.code}
                    lang={capability.lang ?? "tsx"}
                  />
                </div>
              )}
            </div>
          </FadeIn>
        ))}
      </div>
    </div>
  </section>
);
