import { defineConfig } from "blume";

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
    tabs: [
      { icon: "plug", label: "Adapters", path: "/docs/adapters" },
      { icon: "sparkles", label: "AI", path: "/docs/ai" },
      { icon: "code", label: "API", path: "/docs/api" },
      { icon: "terminal", label: "CLI", path: "/docs/cli" },
      { icon: "blocks", label: "Plugins", path: "/docs/plugins" },
      { icon: "layout-dashboard", label: "UI", path: "/docs/ui" },
    ],
  },

  // The Adapters and AI tabs point at folders with no index page, so send the
  // bare tab route to a sensible first page. (Old root URLs → /docs/* live in
  // vercel.json, since Blume redirects can't wildcard.)
  redirects: [
    { from: "/docs/adapters", status: 302, to: "/docs/adapters/s3" },
    { from: "/docs/ai", status: 302, to: "/docs/ai/openai" },
  ],

  theme: {
    accent: "blue",
  },

  title: "Files SDK",
});
