# Client-side uploads with `signedUploadUrl`

The pattern: server mints a short-lived presigned credential, browser uploads directly to the storage provider. The bucket never sits behind your app server.

## The cardinal rule: pass `maxSize`

Without `maxSize`, the adapter returns a presigned **`PUT`** URL with **no server-side size limit**. Anyone with the URL can stream an unbounded file until `expiresIn` elapses. With `maxSize`, the adapter returns a presigned **`POST`** form (S3/R2 family) whose `content-length-range` policy is enforced by the storage provider itself.

```ts
// Bad — no size enforcement
await files.signedUploadUrl(key, { expiresIn: 60 });

// Good — POST policy with size bounds
await files.signedUploadUrl(key, {
  expiresIn: 60,
  contentType: "image/png",
  maxSize: 5 * 1024 * 1024, // 5 MB
});
```

`minSize` defaults to `1` (rejects empty uploads). Pass `0` if zero-byte uploads are legitimate for your use case.

## Return shape (discriminated union)

```ts
type SignedUpload =
  | { method: "PUT"; url: string; headers?: Record<string, string> }
  | { method: "POST"; url: string; fields: Record<string, string> };
```

The client must handle both. Discriminate on `method`.

## Server: Next.js route handler

```ts
// app/api/uploads/sign/route.ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { NextResponse } from "next/server";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

export async function POST(req: Request) {
  const { filename, contentType } = await req.json();

  // Always derive the key server-side. Never accept a fully-trusted key
  // from the client — that lets the caller overwrite arbitrary objects.
  const key = `user-uploads/${crypto.randomUUID()}/${filename}`;

  const signed = await files.signedUploadUrl(key, {
    expiresIn: 60,
    contentType,
    maxSize: 10 * 1024 * 1024, // 10 MB
  });

  return NextResponse.json({ key, signed });
}
```

## Client: handle both PUT and POST

```ts
async function uploadFromBrowser(file: File) {
  const res = await fetch("/api/uploads/sign", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });
  const { key, signed } = await res.json();

  if (signed.method === "PUT") {
    const put = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body: file,
    });
    if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
  } else {
    // POST: send as multipart/form-data with fields first, file LAST.
    const form = new FormData();
    for (const [k, v] of Object.entries(signed.fields)) form.append(k, v);
    form.append("file", file); // must be the last field
    const post = await fetch(signed.url, { method: "POST", body: form });
    if (!post.ok) throw new Error(`POST failed: ${post.status}`);
  }

  return key;
}
```

**Important detail for the POST path:** the file field must be appended **after** all the policy fields. S3/R2 read fields in order and apply the policy to whatever comes after — putting `file` first means the policy never gets evaluated against it.

## Confirming the upload server-side

The client knows the upload returned 2xx, but a hostile client can lie. If the upload matters (billing, content moderation, search indexing), have the client call back and confirm; the server then runs `files.head(key)` to verify the object exists and has the expected `contentType`/`size`.

```ts
const meta = await files.head(key);
if (meta.size > 10 * 1024 * 1024) {
  await files.delete(key);
  throw new Error("Oversized upload slipped through");
}
```

## When to use the PUT path on purpose

Skip `maxSize` (accept the PUT path) only when:

- The upload happens on a trusted backend, not in a user's browser.
- You're in a dev script and just want the shortest path to "object lands in bucket."
- The adapter doesn't support presigned POST at all (some non-S3 adapters fall back to PUT regardless). Treat this as a hard provider limitation, not a security stance.
