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
  content: {
    sources: [
      // Local docs under docs/ → /docs/* (the marketing homepage owns "/").
      filesystem({ prefix: "docs", root: "docs" }),
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

  github: {
    branch: "main",
    dir: "apps/web/docs",
    owner: "haydenbleasel",
    repo: "files-sdk",
  },

  integrations: [blumeTypescriptExternal],

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
      { label: "UI", path: "/docs/ui" },
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
