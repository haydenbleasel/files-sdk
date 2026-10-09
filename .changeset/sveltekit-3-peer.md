---
"files-sdk": patch
---

Accept `@sveltejs/kit` 3 as a peer of the SvelteKit gateway binding (`files-sdk/sveltekit`), alongside 2. `createRouteHandler` only relies on the `RequestHandler` type, which is unchanged in SvelteKit 3, so the same `{ GET, POST, PUT }` exports work on either major.
