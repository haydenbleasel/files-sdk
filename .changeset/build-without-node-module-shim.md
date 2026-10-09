---
"files-sdk": patch
---

The published build no longer imports `node:module` from the root `files-sdk` entry, `files-sdk/r2`, or the other adapter and plugin entries. Bun 1.4.0's bundler emitted an unused `createRequire` shim chunk and imported it from almost every entry, so a Cloudflare Worker without the `nodejs_compat` flag failed to bundle Files SDK with `Could not resolve "node:module"`. The package is now built with Bun 1.4.2, which doesn't emit the shim, and a build-output test bundles the Worker-facing subpaths the way Wrangler does to keep it that way.
