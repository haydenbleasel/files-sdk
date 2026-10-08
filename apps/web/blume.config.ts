import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "blume";

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

export default defineConfig({
  content: {
    sources: [
      // Local docs under docs/ → /docs/* (the marketing homepage owns "/").
      { prefix: "docs", root: "docs", type: "filesystem" },
      // Files SDK's GitHub releases become the changelog timeline at /changelog
      // (each release is a type:changelog entry). Set GITHUB_TOKEN in CI to
      // avoid rate limits; a failed fetch degrades to an empty changelog.
      {
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "files-sdk",
        type: "github-releases",
      },
    ],
  },
  deployment: {
    // Static build served by Cloudflare Workers static assets (see
    // wrangler.jsonc). Workers Builds doesn't expose a site URL the way Pages
    // does, so the canonical origin is pinned here for the sitemap, OG images,
    // and the registry install command.
    site: "https://files-sdk.dev",
  },
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

  // The dog-ear mark + outlined "files" wordmark, as per-mode images so the
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
      display: "group",
    },
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "Changelog", path: "/changelog" },
    ],
  },

  // All redirects (old root URLs → /docs/*, the index-less tab targets, and
  // /docs/overview → /docs) live in public/_redirects — one source of truth,
  // and the only place wildcard rules (/adapters/*) can be expressed. Blume
  // copies public/ into dist/ and leaves an existing _redirects untouched.
  // The /r/* CORS headers live in public/_headers alongside it.

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
