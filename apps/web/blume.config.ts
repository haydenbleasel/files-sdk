import { defineConfig } from "blume";

export default defineConfig({
  // Preserve the old site's llms.txt / llms-full.txt.
  ai: {
    llmsTxt: true,
  },

  content: {
    root: "docs",
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
      { icon: "plug", label: "Adapters", path: "/adapters" },
      { icon: "sparkles", label: "AI", path: "/ai" },
      { icon: "code", label: "API", path: "/api" },
      { icon: "terminal", label: "CLI", path: "/cli" },
      { icon: "blocks", label: "Plugins", path: "/plugins" },
      { icon: "layout-dashboard", label: "UI", path: "/ui" },
    ],
  },

  // The Adapters and AI tabs point at folders with no index page, so send the
  // bare tab route to a sensible first page.
  redirects: [
    { from: "/adapters", status: 302, to: "/adapters/s3" },
    { from: "/ai", status: 302, to: "/ai/openai" },
  ],

  theme: {
    fonts: {
      body: "geist",
      display: "geist",
      mono: "geist-mono",
    },
  },

  title: "Files SDK",
});
