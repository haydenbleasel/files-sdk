---
name: Bug report
about: Create a report to help us improve
title: ""
labels: bug
assignees: ""
---

**Describe the bug** A clear and concise description of what the bug is.

**Minimal reproduction** The smallest snippet that triggers it — the adapter setup and the failing call:

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3"; // the adapter you use

const files = new Files({ adapter: s3({ bucket: "..." }) });

await files.upload("key.txt", "body"); // the call that fails
```

**Expected behavior** What you expected to happen.

**Actual behavior** What happened instead. Include the full error (`FilesError` code and message, plus `cause` if relevant — redact credentials and request IDs you don't want public).

**Environment (please complete the following information):**

- `files-sdk` version: [e.g. 2.6.0]
- Adapter: [e.g. `files-sdk/s3`, `files-sdk/r2`, `files-sdk/vercel-blob`]
- Runtime and version: [e.g. Node 22.11, Bun 1.4.2, Cloudflare Workers, Deno 2.1]
- Provider SDK version, if relevant: [e.g. `@aws-sdk/client-s3` 3.700.0]
- OS: [e.g. macOS 15, Ubuntu 24.04]
