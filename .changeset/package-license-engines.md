---
"files-sdk": patch
---

The published `files-sdk` package now ships its MIT `LICENSE` file (earlier tarballs had none) and declares `"engines": { "node": ">=20" }`, the minimum Node version the SDK runs on (it relies on `Array.prototype.toSorted` and `toReversed`). The package also gains npm `keywords`.
