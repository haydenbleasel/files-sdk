// `files-sdk/client` — the framework-agnostic browser/Node client. All the verb
// logic lives here so it is tested once and reused by `files-sdk/react` and
// `files-sdk/vue`. Importable server-side too (it only references
// `fetch`/`XMLHttpRequest`/`FormData`/`Blob` as globals).
//
// Uses `export *` (not `export { … } from`): Bun strips a pure named re-export
// entry to an unbound stub, so the value modules must be star-exported to keep
// the bundle's runtime exports bound.

// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; export * keeps Bun's runtime exports bound (see header)
export * from "./files-client.js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; export * keeps Bun's runtime exports bound (see header)
export * from "./progress.js";
export type { SendRequest, SendResult, Transport } from "./transport.js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; export * keeps Bun's runtime exports bound (see header)
export * from "./types.js";
