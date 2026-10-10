---
"files-sdk": patch
---

The reactive queries in `files-sdk/react`, `files-sdk/vue` and `files-sdk/svelte` (`useFile`, `useList`, `useSearch`) now honor the `signal` option. It was documented as merged into every call but was ignored. Aborting it cancels the query's request and settles the query with an `aborted` `FilesError`, and the query removes its listener once its request settles or is replaced.
