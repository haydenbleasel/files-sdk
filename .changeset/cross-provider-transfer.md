---
"files-sdk": minor
---

Add `transfer` for cross-provider migration.

`transfer(source, dest, options?)` streams every object from one `Files` instance to another — the one operation the unified surface uniquely enables, since `copy`/`move` live inside a single adapter. It's built entirely on public primitives (the source's `listAll` + streaming `download`, the destination's `exists` + `upload`), so no adapter implements anything new.

```ts
import { Files, transfer } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { r2 } from "files-sdk/r2";

const from = new Files({ adapter: s3({ bucket: "old" }) });
const to = new Files({
  adapter: r2({ bucket: "new", accountId, accessKeyId, secretAccessKey }),
});

const { transferred, skipped, errors } = await transfer(from, to, {
  prefix: "uploads/",
  onProgress: ({ done, key }) => console.log(done, key),
});
```

Both sides are full `Files` instances, so each leg honors its own `prefix`, retries, timeouts, and hooks. Each object is streamed download-to-upload — the destination never buffers a whole large file. Body, content type, and user metadata travel; `etag`/`lastModified` are destination-assigned and `Cache-Control` is not carried.

Like the bulk array methods, `transfer` doesn't throw on partial failure: results come back as `{ transferred, skipped?, errors? }` in walk order. Options cover `prefix`, `transformKey`, `overwrite` (skip keys already present), `concurrency` (default 8), `limit` (walk page size), `stopOnError` (sequential, bail at first failure), `signal`, and `onProgress`.
