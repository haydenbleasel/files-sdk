// `files-sdk/client` — the framework-agnostic browser/Node client. All the verb
// logic lives here so it is tested once and reused by `files-sdk/react` and
// `files-sdk/vue`. Importable server-side too (it only references
// `fetch`/`XMLHttpRequest`/`FormData`/`Blob` as globals).
//
// Uses `export *` (not `export { … } from`): Bun strips a pure named re-export
// entry to an unbound stub, so the value modules must be star-exported to keep
// the bundle's runtime exports bound.

export * from "./files-client.js";
export * from "./progress.js";
export type { SendRequest, SendResult, Transport } from "./transport.js";
export * from "./types.js";
