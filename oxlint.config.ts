import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
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
  extends: [core, react, astro, antiSlop],
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
        // The React Compiler rule family (formerly the single
        // `react/react-compiler` rule): these trees aren't compiled and lean
        // on refs/effects idiomatically.
        "react/exhaustive-effect-dependencies": "off",
        "react/memo-dependencies": "off",
        "react/no-unescaped-entities": "off",
        "react/refs": "off",
        "react/set-state-in-effect": "off",
      },
    },
    {
      // Adapter tests stub an SDK's client + error classes side by side.
      files: ["packages/files-sdk/test/**"],
      rules: {
        // anti-slop's type-evidence rules assume production data flow: parse
        // at the boundary, keep the inferred type, justify every assertion.
        // Test doubles are the opposite by design — a bare object cast to
        // `Files`, a fake SDK client that only implements the two methods
        // under test, an `unknown`-typed spy argument — so these rules would
        // demand ~2000 `SAFETY:` comments on mocks. The behavioural rules
        // (empty-object spreads, module mocking, Reflect access, `shape`
        // names) stay on; `packages/files-sdk/src` is held to the full set.
        "anti-slop/no-chained-type-assertions": "off",
        "anti-slop/no-known-value-widening": "off",
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-widen-then-assert": "off",
        "anti-slop/require-safety-comment-for-type-assertion": "off",
        "max-classes-per-file": "off",
      },
    },
  ],
  rules: {
    // Plugins are middleware: `next` is a continuation that we await mid-op and
    // whose result we transform, not a Node-style error-first callback. The
    // rule (deprecated in ESLint core) can't tell the difference and fires on
    // every plugin verb, so it's off here.
    "node/callback-return": "off",
    // The SDK isn't compiled by the React Compiler, so "syntax the compiler
    // can't lower yet" (for-await, try/finally) is not a defect here — and the
    // rule also fires on the Vue/Svelte `use*` composables.
    "react/todo": "off",
  },
});
