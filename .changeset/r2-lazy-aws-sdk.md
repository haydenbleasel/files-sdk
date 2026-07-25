---
"files-sdk": patch
---

Keep `@aws-sdk/*` out of the static module graph reachable from `files-sdk/r2` so binding- and fetch-mode Workers bundle without the optional peers installed. Consumer bundlers (e.g. rolldown-vite with the Cloudflare Vite plugin) resolve even dynamically-imported chunks at build time, so the s3 entry's static SDK imports behind the r2 adapter's lazy boundary hard-errored with `MISSING_EXPORT` against the optional-peer placeholder (#105). The s3 engine is now SDK-parameterized (`s3/core.js`); `files-sdk/s3` wires it from static imports as before, while the r2 aws-sdk engine loads the SDK modules via dynamic import on first use. No behavior change for `files-sdk/s3` consumers.
