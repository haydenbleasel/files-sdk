import { defineConfig } from "oxlint";
import astro from "ultracite/oxlint/astro";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

// The core SDK source (`packages/files-sdk/src`) is held to the full ultracite
// ruleset — where a rule genuinely doesn't fit, the exception is an inline
// `oxlint-disable-next-line` at the call site so it's visible and grep-able.
// The relaxations below are scoped to the peripheral trees only: test code
// (mocks/fixtures lean on idioms the rules dislike) and the presentational
// React trees (Remotion videos + the web app / shadcn registry), which trip a
// batch of opinionated react/react-doctor rules by their nature.
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
      files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
      rules: {
        // `fs.live.test.ts` / `s3.live.test.ts` gate live suites via the name.
        "github/filenames-match-regex": "off",
        // `.then()`/`.catch()` one-liners read better than await in assertions.
        "github/no-then": "off",
        // Test mocks/fixtures legitimately trip these style/security/fs rules.
        "sonarjs/bool-param-default": "off",
        "sonarjs/cognitive-complexity": "off",
        "sonarjs/expression-complexity": "off",
        "sonarjs/file-permissions": "off",
        // PascalCase test components (e.g. `Comp`).
        "sonarjs/function-name": "off",
        "sonarjs/max-union-size": "off",
        "sonarjs/no-built-in-override": "off",
        "sonarjs/no-hardcoded-ip": "off",
        // `(this.listeners[t] ??= []).push(...)` is the idiomatic emitter mock.
        "sonarjs/no-nested-assignment": "off",
        "sonarjs/no-nested-conditional": "off",
        "sonarjs/no-nested-template-literals": "off",
        "sonarjs/no-undefined-assignment": "off",
        "sonarjs/no-unused-vars": "off",
        "sonarjs/no-wildcard-import": "off",
        "sonarjs/pseudo-random": "off",
        "sonarjs/public-static-readonly": "off",
        "sonarjs/publicly-writable-directories": "off",
        "sonarjs/too-many-break-or-continue-in-loop": "off",
        "sonarjs/use-type-alias": "off",
      },
    },
    {
      // Remotion videos + web app / shadcn registry: presentational React.
      files: ["packages/videos/**", "apps/web/**"],
      rules: {
        // Loops in demo/data-prep code aren't hot paths.
        "react-doctor/async-await-in-loop": "off",
        "react-doctor/async-defer-await": "off",
        // Static, stable-order presentational lists key by index.
        "react-doctor/no-array-index-as-key": "off",
        "react-doctor/no-many-boolean-props": "off",
        // Registry components keep `useContext` for broad React-version compat.
        "react-doctor/no-react19-deprecated-apis": "off",
        // Component modules co-locate constants/config on purpose.
        "react-doctor/only-export-components": "off",
        // Not adopting the React Compiler; manual memoization is intentional.
        "react-doctor/react-compiler-no-manual-memoization": "off",
        "react/no-unescaped-entities": "off",
        "react/react-compiler": "off",
        // Opinionated thresholds we don't enforce on presentational code.
        "sonarjs/cognitive-complexity": "off",
        "sonarjs/expression-complexity": "off",
        // PascalCase components trip the camelCase name regex.
        "sonarjs/function-name": "off",
        "sonarjs/no-duplicate-string": "off",
        "sonarjs/no-nested-conditional": "off",
        "sonarjs/no-undefined-assignment": "off",
        "sonarjs/too-many-break-or-continue-in-loop": "off",
      },
    },
    {
      files: ["packages/videos/**"],
      rules: {
        // Remotion animates almost everything via inline `style`, and caption/
        // label type is intentionally small.
        "react-doctor/no-inline-exhaustive-style": "off",
        "react-doctor/no-tiny-text": "off",
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
