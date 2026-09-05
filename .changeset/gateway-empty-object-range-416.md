---
"files-sdk": patch
---

Fix the `files-sdk/api` proxy download returning a 500 for a suffix `Range` request (`bytes=-N`) against an empty object. The header resolved to an inverted byte range that the SDK rejected as invalid; the gateway now answers `416 Range Not Satisfiable` with `Content-Range: bytes */0`, as it already did for other unsatisfiable ranges.
