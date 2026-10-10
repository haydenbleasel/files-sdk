---
"files-sdk": patch
---

The `files upload` CLI's `--metadata` flag now takes one `key=value` pair per flag; repeat the flag for more (`--metadata team=finance --metadata quarter=q1`). It used to be variadic and swallowed the positional key that followed it, so `files upload --metadata a=1 report.pdf --file r.pdf` failed. Several pairs after a single `--metadata` are now refused as extra arguments.
