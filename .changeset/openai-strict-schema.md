---
"files-sdk": patch
---

Fixed `createResponsesFileTools` emitting a schema that OpenAI rejects with a 400 when a tool override sets `strict: true`. Strict tools now list every property in `required`, mark optional fields nullable, set `additionalProperties: false` on every object, and drop free-form maps (so `uploadFile` has no `metadata` field under strict mode); `execute` treats `null` arguments for optional fields as absent.
