---
"files-sdk": patch
---

Expand test coverage for `box`, `fs`, `onedrive`, `supabase`, and `openai/responses` adapters. Adds tests covering `mapBoxError` / `mapGraphError` non-API error shapes, trailing-slash key handling, no-extension content-type inference, cache-miss reuse and non-file conflict paths in Box, trailing-slash URL trimming in Supabase, and ENOENT mid-page plus non-ENOENT walk errors in the fs adapter. No behavior changes.
