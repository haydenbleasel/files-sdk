import { defineConfig } from "oxlint";
import astro from "ultracite/oxlint/astro";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

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
        // Test mocks/fixtures legitimately trip these security/fs/style rules.
        "sonarjs/file-permissions": "off",
        "sonarjs/no-built-in-override": "off",
        "sonarjs/no-hardcoded-ip": "off",
        // `(this.listeners[t] ??= []).push(...)` is the idiomatic emitter mock.
        "sonarjs/no-nested-assignment": "off",
        "sonarjs/pseudo-random": "off",
        "sonarjs/public-static-readonly": "off",
        "sonarjs/publicly-writable-directories": "off",
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
  // Keys are alphabetical to satisfy `eslint/sort-keys`; the rationale for each
  // lives inline. Most entries below are fallout from the ultracite 7.8→7.9
  // bump, which switched on a large batch of sonarjs/react-doctor/react rules
  // that are opinionated or context-blind against this codebase (a streaming
  // storage SDK + Remotion videos), so they're off rather than churning
  // hundreds of correct call sites.
  rules: {
    // `fs.live.test.ts` / `s3.live.test.ts` encode the "gated live integration"
    // suffix in the filename on purpose; it isn't a plain `*.test.ts`.
    "github/filenames-match-regex": "off",
    // We chain `.then()`/`.catch()` deliberately, especially in tests where a
    // one-liner `download(k).then((f) => f.text())` reads better than await.
    "github/no-then": "off",
    // Plugins are middleware: `next` is a continuation that we await mid-op and
    // whose result we transform, not a Node-style error-first callback. The
    // rule (deprecated in ESLint core) can't tell the difference and fires on
    // every plugin verb, so it's off here.
    "node/callback-return": "off",
    // Loops here are intentionally sequential (cursor pagination, ordered
    // uploads, bounded-memory decompression), and "independent" awaits are
    // frequently order/connection-constrained — e.g. a single FTP control
    // connection cannot multiplex commands, so parallelizing would corrupt the
    // protocol. These perf hints are context-blind to that.
    "react-doctor/async-await-in-loop": "off",
    "react-doctor/async-defer-await": "off",
    "react-doctor/async-parallel": "off",
    // Micro-optimizations we trade for readability.
    "react-doctor/js-combine-iterations": "off",
    "react-doctor/js-flatmap-filter": "off",
    // Static, stable-order presentational lists (Remotion frames, demo panels).
    "react-doctor/no-array-index-as-key": "off",
    "react-doctor/no-barrel-import": "off",
    "react-doctor/no-many-boolean-props": "off",
    // Registry components keep `useContext` for broad React-version compat.
    "react-doctor/no-react19-deprecated-apis": "off",
    // Modules co-locate a component with its constants/config on purpose.
    "react-doctor/only-export-components": "off",
    // Not adopting the React Compiler; manual memoization is intentional.
    "react-doctor/react-compiler-no-manual-memoization": "off",
    "react-doctor/server-sequential-independent-await": "off",
    // Apostrophes and quotes in copy don't need HTML entities.
    "react/no-unescaped-entities": "off",
    "react/react-compiler": "off",
    // Stylistic thresholds / preferences we don't enforce.
    "sonarjs/bool-param-default": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/expression-complexity": "off",
    // Route-handler exports must be named GET/POST/PUT (Next/Astro/SvelteKit/
    // TanStack) and React components must be PascalCase — both collide with the
    // enforced camelCase regex.
    "sonarjs/function-name": "off",
    "sonarjs/max-union-size": "off",
    // Repeated string literals (mostly in tests/adapters) don't each warrant an
    // extracted constant.
    "sonarjs/no-duplicate-string": "off",
    "sonarjs/no-nested-conditional": "off",
    "sonarjs/no-nested-template-literals": "off",
    // `undefined` is semantically distinct from `null` across the adapter APIs
    // and option objects (e.g. `{ cursor: undefined }` means "unset", not
    // "null"); blanket-swapping to null would change behaviour.
    "sonarjs/no-undefined-assignment": "off",
    // Doesn't honour the `_`-prefix "intentionally unused" convention this repo
    // uses for omit-via-destructure; TS + core no-unused-vars still cover real
    // dead bindings.
    "sonarjs/no-unused-vars": "off",
    // Barrel index files intentionally `export *` / re-export from adapters.
    "sonarjs/no-wildcard-import": "off",
    "sonarjs/too-many-break-or-continue-in-loop": "off",
    "sonarjs/use-type-alias": "off",
    "unicorn/prefer-export-from": "off",
    // `Number.parseInt(cursor, 10)` (explicit radix) is intentional and clearer
    // than the suggested `Math.trunc(Number(cursor))`.
    "unicorn/prefer-number-coercion": "off",
  },
});
