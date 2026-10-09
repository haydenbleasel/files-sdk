---
"files-sdk": minor
---

Support Nitro 3 / h3 2 in the Nitro gateway binding (`files-sdk/nitro`), alongside Nitro 2 / h3 1. h3 2 hands every runtime a Web `Request` on `event.req`, and the binding now passes it to the gateway as-is. Before, it read `event.node`, which h3 2 only provides on Node, so the route failed with a 500 on Bun, Deno, and edge presets. On h3 1 nothing changes: the Node request is still marshalled, and in-process requests (`localFetch`, SSR `$fetch`) still read their body from the event. The binding no longer imports anything from `h3`, including types, so it typechecks in Nitro 3 apps that only reach h3 through `nitro/h3`. `createRouteHandler`'s parameter is the new structural `NitroEvent` type, which both majors' `H3Event` satisfy, and the `h3` peer range widens to `^1.0.0 || ^2.0.0`.
