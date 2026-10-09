import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "blume";
import { openai } from "blume/ai";
import { cloudflare } from "blume/deploy";
import { cloudflare as cloudflareRateLimit } from "blume/ratelimit";
import { filesystem, githubReleases } from "blume/sources";

// Blume's <AutoTypeTable> lazily `import("typescript")`s the compiler API from
// inside the prerender bundle. Vite externalizes that import as the bare
// specifier, so at prerender time Node resolves it from dist/.prerender/ —
// whose node_modules junction points at the hoisted root — and lands on the
// repo's TypeScript 7 (tsgo), whose package entry has no compiler API. Every
// table then rendered "Cannot read properties of undefined (reading
// 'ESNext')". Pin the external to the TypeScript Blume itself depends on (its
// nested copy), resolved from Blume's package so no version or path is
// hard-coded here.
const blumeRequire = createRequire(
  createRequire(import.meta.url).resolve("blume/package.json")
);
const blumeRoot = path.dirname(blumeRequire.resolve("blume/package.json"));
const blumeTypescript = blumeRequire.resolve("typescript");

const blumeTypescriptExternal = {
  hooks: {
    "astro:config:setup": ({ updateConfig }) => {
      updateConfig({
        vite: {
          plugins: [
            {
              enforce: "pre",
              name: "files-sdk:blume-typescript",
              resolveId: (source, importer) =>
                source === "typescript" && importer?.startsWith(`${blumeRoot}/`)
                  ? { external: true, id: blumeTypescript }
                  : null,
            },
          ],
        },
      });
    },
  },
  name: "files-sdk:blume-typescript",
} satisfies NonNullable<
  Parameters<typeof defineConfig>[0]["integrations"]
>[number];

// Pages that lived at the site root before the docs moved under /docs.
const OLD_ROOT_PAGES = [
  "bulk",
  "cancellations",
  "capabilities",
  "conditional-operations",
  "escape-hatch",
  "faq",
  "installation",
  "multipart",
  "prefixes",
  "provider-gaps",
  "providers",
  "readonly",
  "receipts",
  "resumable",
  "retries",
  "timeouts",
  "troubleshooting",
  "usage",
];

// Pages from earlier docs layouts, by their old path, to where each lives now.
// The old site served docs at the root, and some links carry a /docs prefix,
// so each one redirects from both.
const LEGACY_PAGES = new Map([
  ["api/capabilities", "/docs/capabilities"],
  // The per-adapter compatibility page, now the adapter comparison.
  ["api/compatibility", "/docs/adapters"],
  ["features", "/docs"],
  ["features/bulk", "/docs/bulk"],
  ["features/cancellations", "/docs/cancellations"],
  ["features/escape-hatch", "/docs/escape-hatch"],
  ["features/multipart", "/docs/multipart"],
  ["features/onaction", "/docs/api/onaction"],
  ["features/onerror", "/docs/api/onerror"],
  ["features/onprogress", "/docs/api/onprogress"],
  ["features/onretry", "/docs/api/onretry"],
  ["features/prefixes", "/docs/prefixes"],
  ["features/readonly", "/docs/readonly"],
  ["features/resumable", "/docs/resumable"],
  ["features/retries", "/docs/retries"],
  ["features/timeouts", "/docs/timeouts"],
  ["features/transfer", "/docs/api/transfer"],
  ["files-demo", "/docs/ui"],
  ["react", "/docs/ui"],
  ["react/authorization", "/docs/ui/server/authorization"],
  ["react/frameworks", "/docs/ui/server/gateway"],
  ["react/gateway", "/docs/ui/server/gateway"],
  ["react/svelte", "/docs/ui/client/svelte"],
  ["react/use-files", "/docs/ui/client/react"],
  ["react/vue", "/docs/ui/client/vue"],
  ["ui/authorization", "/docs/ui/server/authorization"],
  ["ui/express", "/docs/ui/server/express"],
  ["ui/gateway", "/docs/ui/server/gateway"],
  ["ui/hono", "/docs/ui/server/hono"],
  ["ui/next", "/docs/ui/server/next"],
  ["ui/react", "/docs/ui/client/react"],
  ["ui/svelte", "/docs/ui/client/svelte"],
  ["ui/vue", "/docs/ui/client/vue"],
]);

// The shadcn registry components (registry/files-sdk/*). Old links reach
// them under /components, /blocks, /docs/components, and bare /docs, and the
// registry JSON without its .json.
const REGISTRY_COMPONENTS = [
  "capabilities-badges",
  "dropzone",
  "file-actions",
  "file-browser",
  "file-list",
  "file-preview",
  "file-search",
  "multipart-uploader",
  "share-dialog",
  "trash-bin",
  "upload-progress",
  "version-history",
];

const OLD_API_PAGES = [
  "copy",
  "delete",
  "download",
  "errors",
  "exists",
  "file",
  "head",
  "list",
  "move",
  "onaction",
  "onerror",
  "onprogress",
  "onretry",
  "search",
  "signed-upload-url",
  "stored-file",
  "sync",
  "transfer",
  "upload",
  "url",
];

export default defineConfig({
  agents: {
    // Entries in the AI catalog (/.well-known/ai-catalog.json), keyed by
    // `<namespace>:<name>`: the docs MCP server and the published skill.
    catalog: {
      queries: {
        "mcp:files-sdk": [
          "search the Files SDK documentation",
          "how do I configure a Files SDK adapter",
          "which storage providers does files-sdk support",
        ],
        "skill:files-sdk": [
          "add file uploads to a TypeScript app",
          "upload files to Cloudflare R2 or S3 from Node.js",
          "switch storage providers without rewriting upload code",
          "let the browser upload files through an authorized gateway",
        ],
      },
    },
    llmsTxt: {
      details: [
        "Reach for Files SDK when a TypeScript or JavaScript project needs to store files in object or blob storage without locking into one provider: uploads and downloads, signed URLs, listing and search, multipart and resumable uploads, and moving data between providers. One `Files` class runs the same methods on 48 adapters (Cloudflare R2, Amazon S3 and every S3-compatible store, Google Cloud Storage, Azure Blob, Vercel Blob, Supabase, the local filesystem, and more). Each adapter is its own subpath export with its provider's SDK as an optional peer.",
        "",
        "Install with `npm i files-sdk`, construct `new Files({ adapter: r2({ bucket }) })`, and call `upload`, `download`, `list`, `url`, and the rest. Plugins such as `files-sdk/encryption` and `files-sdk/validation` wrap the same API. `files-sdk/api` with a framework binding (`files-sdk/next`, `files-sdk/hono`, …) serves browser uploads behind an `authorize` hook, and the `files` CLI and its MCP server expose the same operations to scripts and agents. The `files-sdk` agent skill below covers setup and usage, and the guides under /guides walk through complete workflows end to end: browser uploads, private downloads, AI attachments and storage tools, provider setup, and migrations.",
      ].join("\n"),
    },
    // The docs MCP server at /mcp: search and read these docs. It never
    // touches storage; that's the `files` CLI's own MCP server.
    mcp: {
      enabled: true,
      instructions:
        "This server searches and reads the Files SDK documentation. It doesn't access any storage. To give an agent file operations, run the `files` CLI's MCP server instead (see /docs/cli/mcp).",
    },
    // Publishes skills/files-sdk at /.well-known/agent-skills/files-sdk/ and
    // /skill.md, in place of the generated docs-map skill of the same name.
    skills: "../../skills",
  },
  ai: {
    // The in-page docs assistant, grounded in these docs and answering through
    // OpenAI directly. Its `POST /api/ask` route reads OPENAI_API_KEY at
    // request time: a Worker secret in production (`wrangler secret put
    // OPENAI_API_KEY`), `.env.local` for `blume dev`.
    assistant: {
      enabled: true,
      provider: openai({ model: "gpt-6-luna" }),
      suggestions: [
        { icon: "arrow-left-right", label: "How do I switch from S3 to R2?" },
        { icon: "upload", label: "How do I upload files from the browser?" },
        { icon: "lock", label: "How do I encrypt files at rest?" },
      ],
    },
  },
  // The generated /changelog index's meta description.
  changelog: {
    description:
      "Every Files SDK release, newest first: new adapters, plugins, and features, fixes, and breaking changes, from the release notes on GitHub.",
  },
  content: {
    sources: [
      // Local docs under docs/ → /docs/* and guides under guides/ →
      // /guides/* (the marketing homepage owns "/"). One source rooted at the
      // app with a glob per folder: Blume's filesystem sources have to share
      // a root.
      filesystem({
        include: ["docs/**/*.{md,mdx}", "guides/**/*.{md,mdx}"],
        root: ".",
      }),
      // Files SDK's GitHub releases become the changelog timeline at /changelog
      // (each release is a type:changelog entry). Set GITHUB_TOKEN in CI to
      // avoid rate limits; a failed fetch degrades to an empty changelog.
      githubReleases({
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "files-sdk",
      }),
    ],
  },
  // A server build on Cloudflare Workers: the assistant's route can't run on a
  // static build. Prerendered pages still ship as static assets alongside the
  // Worker. Workers doesn't expose a site URL the way Pages does, so the
  // canonical origin is pinned for the sitemap, OG images, and the registry
  // install command.
  deployment: cloudflare({ site: "https://files-sdk.dev" }),
  description:
    "A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.",

  examples: {
    // Preview frames are iframes that get none of the docs sheet, so the
    // shadcn tokens (bg-primary, bg-popover, …), tw-animate-css and the
    // data-open/data-closed variants the registry components use have to be
    // injected into them too; theme.css is the one source for all three.
    css: "theme.css",
    // Preview only the example files; the glob skips the named-export
    // component sources colocated alongside them (which have no default
    // export).
    source: "registry/files-sdk/**/examples/*",
  },

  // Docs pages only: the homepage passes its own footer.
  footer: {
    copyright: `© ${new Date().getFullYear()} Hayden Bleasel. MIT licensed.`,
    links: [
      { href: "https://www.npmjs.com/package/files-sdk", label: "npm" },
      { href: "https://github.com/sponsors/haydenbleasel", label: "Sponsor" },
      {
        href: "https://github.com/haydenbleasel/files-sdk/issues",
        label: "Report an issue",
      },
    ],
    socials: { x: "https://x.com/haydenbleasel" },
  },

  github: {
    branch: "main",
    // The app, not the content folder: edit links join this with each page's
    // path from the app root (docs/…, guides/…).
    dir: "apps/web",
    owner: "haydenbleasel",
    repo: "files-sdk",
  },

  integrations: [blumeTypescriptExternal],

  // "Last updated" dates from each page's git history. The deploy workflow
  // checks out the full history for this.
  lastModified: "git",

  // The dog-ear mark + outlined "Files SDK" wordmark, as per-mode images so the
  // lockup renders identically in the docs header and on custom pages (whose
  // PageLayout doesn't forward the `Logo` layout slot). `text: ""` drops the
  // title text beside it; the image alt carries the accessible name.
  logo: {
    image: {
      alt: "Files SDK",
      dark: "/logo-dark.svg",
      light: "/logo-light.svg",
    },
    text: "",
  },

  navigation: {
    sidebar: {
      display: "flat",
    },
    // One tab per area, each scoping the sidebar to its own folder (the
    // longest matching path wins). Docs is the root tab (`path: "/"`) rather
    // than `/docs`: only the root tab hides the other tabs' sections from its
    // sidebar, so the general pages (installation, usage, concepts, …) don't
    // repeat every area as a sidebar group. `href` keeps it linking to /docs.
    // The AI and CLI pages have no tab and sit in the Docs sidebar.
    tabs: [
      { href: "/docs", label: "Docs", path: "/" },
      { label: "API", path: "/docs/api" },
      { label: "Adapters", path: "/docs/adapters" },
      { label: "Plugins", path: "/docs/plugins" },
      { label: "Events", path: "/docs/events" },
      { label: "UI", path: "/docs/ui" },
      // The hub at /guides is a custom page (pages/guides/index.astro), not
      // a content page, so the tab names it rather than its first guide.
      { href: "/guides", label: "Guides", path: "/guides" },
      { label: "Changelog", path: "/changelog" },
    ],
  },

  // Count assistant questions with Workers rate limiting (Blume declares the
  // binding at build time): an in-memory count resets per Worker instance.
  rateLimit: cloudflareRateLimit({ requests: 10, window: 60 }),

  // Old root URLs → /docs/*, plus the index-less sidebar groups. These live
  // here rather than in public/_redirects: on a server build the Worker
  // answers every page request first, so Cloudflare never consults that file.
  // The old /api/* pages are listed one by one because a /api/* pattern would
  // also swallow the assistant's /api/ask route and Blume's /api/docs/* JSON.
  // The /r/* CORS headers stay in public/_headers, which still applies.
  redirects: [
    // Before the area patterns below, so an old /ui/<page> lands in one hop.
    ...[...LEGACY_PAGES].flatMap(([from, to]) =>
      [`/${from}`, `/docs/${from}`].map((oldPath) => ({
        from: oldPath,
        status: 301 as const,
        to,
      }))
    ),
    ...REGISTRY_COMPONENTS.flatMap((name) => [
      ...["/components", "/blocks", "/docs/components", "/docs"].map(
        (base) => ({
          from: `${base}/${name}`,
          status: 301 as const,
          to: `/docs/ui/components/${name}`,
        })
      ),
      { from: `/r/${name}`, status: 301 as const, to: `/r/${name}.json` },
    ]),
    ...["/components", "/blocks", "/docs/components"].map((from) => ({
      from,
      status: 301 as const,
      to: "/docs/ui/components/dropzone",
    })),
    { from: "/updates/:slug*", status: 301, to: "/changelog" },
    // URLs crawlers and old shares still request: the Next.js-era OG image,
    // conventional icon and sitemap names, and a link someone published with
    // a stray trailing backslash.
    { from: "/opengraph-image", status: 301, to: "/og/index.png" },
    { from: "/opengraph-image.png", status: 301, to: "/og/index.png" },
    { from: "/apple-touch-icon.png", status: 301, to: "/apple-icon.png" },
    {
      from: "/apple-touch-icon-precomposed.png",
      status: 301,
      to: "/apple-icon.png",
    },
    { from: "/sitemap_index.xml", status: 301, to: "/sitemap.xml" },
    { from: "/sitemap-index.xml", status: 301, to: "/sitemap.xml" },
    {
      from: "/docs/adapters/vercel-blob\\",
      status: 301,
      to: "/docs/adapters/vercel-blob",
    },
    ...["adapters", "ai", "cli", "plugins", "ui"].map((area) => ({
      from: `/${area}/:path*`,
      status: 301 as const,
      to: `/docs/${area}/:path*`,
    })),
    { from: "/api", status: 301, to: "/docs/api" },
    ...OLD_API_PAGES.map((page) => ({
      from: `/api/${page}`,
      status: 301 as const,
      to: `/docs/api/${page}`,
    })),
    ...OLD_ROOT_PAGES.map((page) => ({
      from: `/${page}`,
      status: 301 as const,
      to: `/docs/${page}`,
    })),
    { from: "/overview", status: 301, to: "/docs" },
    { from: "/docs/overview", status: 301, to: "/docs" },
    { from: "/docs/ai", status: 302, to: "/docs/ai/vercel" },
    { from: "/docs/ui/client", status: 302, to: "/docs/ui/client/react" },
    {
      from: "/docs/ui/components",
      status: 302,
      to: "/docs/ui/components/dropzone",
    },
    { from: "/docs/ui/server", status: 302, to: "/docs/ui/server/gateway" },
  ],

  seo: {
    og: {
      // The dog-ear mark in place of the default initial tile on generated
      // social cards (public/icon.svg is also the favicon).
      logo: "/icon.svg",
    },
    // schema.org identity: an Organization on every page and a
    // SoftwareApplication on the homepage, for search engines and agents.
    organization: {
      logo: "/icon.svg",
      name: "Files SDK",
      sameAs: [
        "https://github.com/haydenbleasel/files-sdk",
        "https://www.npmjs.com/package/files-sdk",
        "https://x.com/haydenbleasel",
      ],
    },
    software: {
      license: "https://opensource.org/license/mit",
      operatingSystem: "Node.js 20+, Bun, Deno, Cloudflare Workers",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/files-sdk",
        "https://github.com/haydenbleasel/files-sdk",
      ],
    },
    x: { creator: "@haydenbleasel", handle: "@haydenbleasel" },
  },

  theme: {
    // Monochrome chrome: ink on paper, paper on ink. The brand's highlighter
    // lime is reserved for the dog-ear and highlights (see theme.css).
    accent: { dark: "#fafafa", light: "#0a0a0a" },
    fonts: {
      body: { name: "Funnel Sans", weights: ["300..800"] },
      display: { name: "Funnel Display", weights: ["300..800"] },
      mono: "geist-mono",
    },
  },

  title: "Files SDK",
});
