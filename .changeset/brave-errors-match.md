---
"files-sdk": patch
---

`FilesError` now matches across bundled copies of the class. The package root, the edge entries (`files-sdk/api`, `files-sdk/client`, …) and each framework binding bundle their own copy, so `instanceof FilesError` failed whenever an error crossed entry points: a `files-sdk/api` gateway answered 500 `Provider` for every `FilesError` raised by `Files` (a missing key returned 500 instead of 404) or thrown from `authorize` (500 instead of 401), and errors from `files-sdk/client` or `useFiles` did not match the `FilesError` imported from `files-sdk`. Resolves #164.
