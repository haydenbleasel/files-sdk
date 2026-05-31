---
"files-sdk": patch
---

Switch the build from tsup to Bun's bundler (for JavaScript) plus tsgo (for type declarations), orchestrated by `scripts/build.ts`. tsup is no longer maintained and its declaration emit needed an enlarged Node heap; the replacement builds the whole package — every adapter, plugin, and the CLI — in well under a second with no heap flag. The published ESM output and `exports` map are unchanged, so imports resolve identically. The only packaging difference is that type declarations are now emitted per source file rather than rolled up into bundled `.d.ts` files; type resolution for consumers is equivalent.
