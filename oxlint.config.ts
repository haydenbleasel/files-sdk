import { defineConfig } from "oxlint";
import astro from "ultracite/oxlint/astro";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

// The core SDK source (`packages/files-sdk/src`) is held to the full ultracite
// ruleset — where a rule genuinely doesn't fit, the exception is an inline
// `oxlint-disable-next-line` at the call site so it's visible and grep-able.
// The relaxations below are scoped to the peripheral trees only: the
// presentational React trees (Remotion videos + the web app / shadcn registry),
// which trip a batch of opinionated react rules by their nature.
export default defineConfig({
  extends: [core, react, astro],
  ignorePatterns: [
    "apps/web/components/ui",
    "apps/web/lib/utils.ts",
    "apps/web/hooks/use-mobile.ts",
    "packages/files-sdk/CHANGELOG.md",
    // Svelte test fixtures — oxlint has no Svelte parser, so `.svelte` source
    // trips JS-only rules (`export let` props, etc.).
    "packages/files-sdk/test/fixtures",
  ],
  overrides: [
    {
      // Remotion videos + web app / shadcn registry: presentational React.
      files: ["packages/videos/**", "apps/web/**"],
      rules: {
        "react/no-unescaped-entities": "off",
        "react/react-compiler": "off",
      },
    },
  ],
  rules: {
    // Plugins are middleware: `next` is a continuation that we await mid-op and
    // whose result we transform, not a Node-style error-first callback. The
    // rule (deprecated in ESLint core) can't tell the difference and fires on
    // every plugin verb, so it's off here.
    "node/callback-return": "off",
  },
});
