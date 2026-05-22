---
"files-sdk": minor
---

Add FTP and SFTP adapters (`files-sdk/ftp`, `files-sdk/sftp`) for on-prem and legacy file servers. Both expose the standard unified surface, so they're interchangeable with the cloud adapters:

```ts
import { Files } from "files-sdk";
import { sftp } from "files-sdk/sftp";

const files = new Files({
  adapter: sftp({
    host: "files.example.com",
    username: process.env.SFTP_USERNAME!,
    privateKey: process.env.SFTP_PRIVATE_KEY!,
    root: "/uploads",
  }),
});

await files.upload("reports/q1.csv", csv, { contentType: "text/csv" });
```

FTP uses [`basic-ftp`](https://www.npmjs.com/package/basic-ftp) (with FTPS via `secure: true`); SFTP uses [`ssh2-sftp-client`](https://www.npmjs.com/package/ssh2-sftp-client). Both are optional peer dependencies. These adapters are **Node-only** (raw sockets — no edge/browser/Workers support) and connect per operation by default; pass a pre-connected `client` to reuse one connection for batch work. Keys resolve under a configurable `root` with a `..` traversal guard, `list` walks the tree recursively with cursor pagination, and `deleteMany` reuses a single connection. These protocols store no MIME type (inferred from the file extension), no arbitrary `metadata`/`cacheControl` (both throw), and serve no HTTP — `url()` requires a `publicBaseUrl` pointing at an HTTP server fronting the same tree, and `signedUploadUrl()` throws. `copy` round-trips the bytes through the client since neither protocol has a portable server-side copy.
