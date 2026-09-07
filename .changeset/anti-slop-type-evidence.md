---
"files-sdk": patch
---

Type-evidence pass across the SDK (adopting the `anti-slop` lint rules): every remaining type assertion now states the invariant that makes it hold, `unknown` no longer leaks through internal signatures, and runtime `typeof` probes go through named predicates. Along the way this surfaced and fixed a few real defects:

- `box()`: `lastModified` was silently dropped on real responses. The Box SDK deserializes `modified_at` into a date wrapper (`{ value: Date }`), and the adapter was reading it as an ISO string, so `new Date(...)` produced an Invalid Date. Both the wrapper and the string form are now unwrapped correctly.
- `getProvider()` no longer resolves `Object.prototype` names: `getProvider("constructor")` returned `Object.prototype.constructor` instead of `undefined`.
- Provider error mappers (Vercel Blob, UploadThing, Bunny, PocketBase, Supabase, Cloudinary, Netlify) only adopt `message`/`status`/`code`/`name` from a thrown value when they have the expected primitive type, instead of copying whatever was there into the `FilesError`.
- `supabase()`'s client detection no longer treats `{ storage: null }` as a Supabase client.
- CLI: `--to` and `--config-json` values that decode to a non-object JSON value (an array, a string, a number) are rejected up front with a clear message instead of failing later or being spread character-by-character into the adapter options.

No public type changes in meaning. Two parameter _names_ in exported types changed from `reason` to `cause` (`UploadControl.abort` and the `abort` returned by `useFiles`), which does not affect assignability.
