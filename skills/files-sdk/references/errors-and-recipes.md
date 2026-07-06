# Errors and migration recipes

## `FilesError`

Every adapter error is wrapped before it reaches your code.

```ts
import { FilesError } from "files-sdk";
import type { FilesErrorCode } from "files-sdk";
```

Shape:

```ts
class FilesError extends Error {
  readonly code: FilesErrorCode; // "NotFound" | "Unauthorized" | "Conflict" | "ReadOnly" | "Provider"
  readonly aborted: boolean; // true for a cancellation or timeout
  readonly cause?: unknown; // the original provider error
}
```

`code` is the field worth branching on:

| Code | Meaning |
| --- | --- |
| `NotFound` | The object or key (or bucket/container) does not exist. |
| `Unauthorized` | Credentials are missing, wrong, or lack the required permission. |
| `Conflict` | Precondition failed — e.g. `If-Match` mismatch, create-only collision. |
| `ReadOnly` | A write was attempted on a `new Files({ readonly: true })` / `files.readonly()`. |
| `Provider` | Catch-all for anything else (transport, throttling, malformed input, timeouts). |

Codes map from the provider's own error/HTTP status (`404` → `NotFound`, `401`/`403` → `Unauthorized`, `409`/`412` → `Conflict`); `ReadOnly` is the one SDK-native code. Only `Provider` is retried — the rest are deterministic and returned immediately.

### The `aborted` flag

A cancellation (via a `signal` you abort) or a `timeout` rejects with `code: "Provider"` **and** `aborted: true`. That flag — not the code — is how you tell an intentional abort apart from a genuine provider failure, and aborts are never retried.

```ts
try {
  await files.download("big.zip", { signal: controller.signal });
} catch (err) {
  if (err instanceof FilesError && err.aborted) {
    return; // expected — the caller (or a timeout) aborted it
  }
  throw err;
}
```

Use it like this:

```ts
try {
  await files.head(key);
} catch (err) {
  if (err instanceof FilesError && err.code === "NotFound") {
    return null;
  }
  throw err; // never silently swallow Unauthorized / Provider
}
```

### Logging the `cause`

The original provider error sits on `.cause` for debugging. It can carry request IDs, response headers, and partial request metadata — especially from `@aws-sdk`. If you serialize `FilesError` into logs that cross a trust boundary, strip or whitelist `cause` rather than `JSON.stringify`-ing the whole thing.

## The `exists()` trap

`exists(key)` returns `false` **only** when the provider reports `NotFound`. Auth failures, transport errors, and bad credentials still throw.

```ts
// Wrong — treats Unauthorized as "file is missing"
const present = await files.exists(key).catch(() => false);

// Right — let non-NotFound errors propagate
const present = await files.exists(key);
```

If you actually want "best effort, log and move on," catch `FilesError` and inspect `.code`. Do not blanket-catch.

## The `head()` accessor footgun

`head(key)` returns a `StoredFile`. The metadata fields (`size`, `contentType`, `etag`, `metadata`) are populated immediately, but `text()` / `arrayBuffer()` / `blob()` / `stream()` **lazily issue a full GET on first use**. If all you want is metadata, don't touch the body accessors — they are not free.

## URL key encoding

The SDK does not URL-encode keys when building public URLs (or Vercel Blob's fast path). The caller is responsible. If keys are derived from untrusted input:

```ts
const safe = pathSegments.map(encodeURIComponent).join("/");
const url = await files.url(safe);
```

## Migration: `@aws-sdk/client-s3` → `files-sdk/s3`

Before:

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3client = new S3Client({ region: "us-east-1" });

await s3client.send(
  new PutObjectCommand({
    Bucket: "uploads",
    Key: "avatars/abc.png",
    Body: file,
    ContentType: "image/png",
  })
);

const got = await s3client.send(
  new GetObjectCommand({ Bucket: "uploads", Key: "avatars/abc.png" })
);
const bytes = await got.Body!.transformToByteArray();
```

After:

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

await files.upload("avatars/abc.png", file, { contentType: "image/png" });

const got = await files.download("avatars/abc.png");
const bytes = new Uint8Array(await got.arrayBuffer());
```

Provider-specific things like versioning, multipart, or storage-class controls don't have a unified API — reach for the native client via `files.raw`, which is typed as `S3Client`:

```ts
import { PutObjectCommand } from "@aws-sdk/client-s3";

await files.raw.send(
  new PutObjectCommand({
    Bucket: files.adapter.bucket,
    Key: "archives/2026/q1.zip",
    Body: file,
    StorageClass: "GLACIER_IR",
  })
);
```

## Migration: `@vercel/blob` → `files-sdk/vercel-blob`

Before:

```ts
import { put, head, list, del } from "@vercel/blob";

const { url } = await put("avatars/abc.png", file, {
  access: "public",
  addRandomSuffix: false,
});

const meta = await head(url);
await del(url);
```

After:

```ts
import { Files } from "files-sdk";
import { vercelBlob } from "files-sdk/vercel-blob";

const files = new Files({
  adapter: vercelBlob({ access: "public", addRandomSuffix: false }),
});

await files.upload("avatars/abc.png", file, { contentType: "image/png" });
const url = await files.url("avatars/abc.png");

const meta = await files.head("avatars/abc.png");
await files.delete("avatars/abc.png");
```

The big difference: `@vercel/blob` is URL-keyed (`head(url)`, `del(url)`); files-sdk is key-keyed (`head(key)`, `delete(key)`). The key is the pathname you uploaded.

For private blobs, swap `access: "public"` → `access: "private"` and remember that `files.url(key)` will throw — use `files.download(key)` instead.

## Migration: `@google-cloud/storage` → `files-sdk/gcs`

Before:

```ts
import { Storage } from "@google-cloud/storage";

const storage = new Storage();
const bucket = storage.bucket("uploads");
await bucket.file("avatars/abc.png").save(buf, { contentType: "image/png" });
const [bytes] = await bucket.file("avatars/abc.png").download();
```

After:

```ts
import { Files } from "files-sdk";
import { gcs } from "files-sdk/gcs";

const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
await files.upload("avatars/abc.png", buf, { contentType: "image/png" });
const got = await files.download("avatars/abc.png");
const bytes = new Uint8Array(await got.arrayBuffer());
```

ADC discovery still works the same way (env vars, `gcloud auth`, GCE metadata) — the adapter just delegates.
