---
"files-sdk": patch
---

`files.search()` (and the `files-sdk/api` gateway's `search`) now finds keys when a glob has a wildcard after an escaped brace (`dir\{1\}/*.pdf`), a brace matched literally (`users/{id}/*.json`), or an unclosed bracket. The literal prefix pushed down to `list()` used to be the whole pattern, wildcards included, so the walk listed a prefix no key starts with and the search returned nothing.
