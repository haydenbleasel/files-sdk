---
"files-sdk": patch
---

Fix CLI and MCP output of bulk partial-failure errors. The `errors` arrays embed live `FilesError` instances, and a bare `JSON.stringify` drops `message` (a non-enumerable `Error` property) while serializing the enumerable `cause` — the raw provider error, which can carry request ids and response headers the SDK explicitly warns against shipping across a trust boundary. All CLI/MCP serialization now goes through a replacer that emits `{ code, message, aborted, timedOut }` for any embedded `FilesError` and strips `cause`.
