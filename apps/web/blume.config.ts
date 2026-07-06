import { defineConfig } from "blume";

export default defineConfig({
  analytics: {
    vercel: true,
  },
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
    adapter: "vercel",
  },
  description:
    "A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.",

  // Preview only the example files; the glob skips the named-export component
  // sources colocated alongside them (which have no default export).
  examples: "registry/files-sdk/**/examples/*",

  github: {
    branch: "main",
    dir: "apps/web/docs",
    owner: "haydenbleasel",
    repo: "files-sdk",
  },

  logo: "/logo.svg",

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
  // /docs/overview → /docs) live in vercel.json — one source of truth. Vercel
  // reads that at the project root, not Blume's emitted output, so keeping a
  // second copy here would only apply to local dev.

  theme: {
    accent: "blue",
  },

  title: "Files SDK",
});
