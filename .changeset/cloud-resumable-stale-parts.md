---
"files-sdk": patch
---

Resuming a part-based upload (`upload({ control: UploadControl.from(token) })`) now ignores any already-uploaded part the provider reports past the body's last part, or at a size the body's slicing can't produce, and re-uploads that part where the body has one. `files-sdk/azure` lists every uncommitted block on the blob, including blocks an abandoned upload to the same key left behind, and those were committed into the resumed object, splicing stale bytes into it.
