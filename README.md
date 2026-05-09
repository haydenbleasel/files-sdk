# files-sdk

Unified storage SDK for object/blob backends — AWS S3, Cloudflare R2, Vercel Blob, MinIO, DigitalOcean Spaces, Google Cloud Storage, Azure Blob Storage, Supabase Storage, UploadThing, and a local filesystem adapter for dev/test.

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads" }),
});

await files.upload("avatars/abc.png", file, { contentType: "image/png" });
const got = await files.download("avatars/abc.png");
```

Docs: [files-sdk.dev](https://files-sdk.dev)

## License

MIT
