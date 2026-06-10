---
"files-sdk": patch
---

Fix the CLI eagerly importing optional provider peer dependencies. The bundler previously inlined the registry's lazily-imported provider modules into `dist/cli/index.js`, hoisting their external imports (e.g. `@netlify/blobs`) to the top level — so `files --help` crashed with `ERR_MODULE_NOT_FOUND` unless every optional peer was installed. The build now emits shared chunks so the registry's `await import(...)` calls stay genuinely dynamic: provider-independent commands run without any optional peers installed, and a missing peer only surfaces when its provider is actually selected.
