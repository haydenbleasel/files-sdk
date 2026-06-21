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
});
