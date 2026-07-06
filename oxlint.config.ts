import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [
    "apps/web/components/ui",
    "apps/web/lib/utils.ts",
    "apps/web/hooks/use-mobile.ts",
    "packages/files-sdk/CHANGELOG.md",
    // Svelte test fixtures — oxlint has no Svelte parser, so `.svelte` source
    // trips JS-only rules (`export let` props, etc.).
    "packages/files-sdk/test/fixtures",
  ],
  rules: {
    // Plugins are middleware: `next` is a continuation that we await mid-op and
    // whose result we transform, not a Node-style error-first callback. The
    // rule (deprecated in ESLint core) can't tell the difference and fires on
    // every plugin verb, so it's off here.
    "node/callback-return": "off",
  },
});
