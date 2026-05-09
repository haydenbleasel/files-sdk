import { CodeTabs } from "./code-tabs";

const TABS = [
  {
    code: `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads", region: "us-east-1" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "s3",
    label: "S3",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { r2 } from "files-sdk/r2";

const files = new Files({
  adapter: r2({ bucket: "uploads", accountId: "..." }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "r2",
    label: "R2",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { vercelBlob } from "files-sdk/vercel-blob";

const files = new Files({
  adapter: vercelBlob(),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "vercel-blob",
    label: "Vercel Blob",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { netlifyBlobs } from "files-sdk/netlify-blobs";

// On Netlify, siteID + token come from NETLIFY_BLOBS_CONTEXT.
const files = new Files({
  adapter: netlifyBlobs({ name: "uploads" }),
});

await files.upload("hello.txt", "world");
// Netlify Blobs has no public URL — use download() instead.
const got = await files.download("hello.txt");`,
    id: "netlify-blobs",
    label: "Netlify Blobs",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";

const files = new Files({
  adapter: minio({ bucket: "uploads", endpoint: "http://localhost:9000" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "minio",
    label: "MinIO",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { storj } from "files-sdk/storj";

// Defaults to https://gateway.storjshare.io (Gateway MT).
// STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY read from env.
const files = new Files({
  adapter: storj({ bucket: "uploads" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "storj",
    label: "Storj",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { hetzner } from "files-sdk/hetzner";

// HCLOUD_ACCESS_KEY_ID / HCLOUD_SECRET_ACCESS_KEY read from env.
const files = new Files({
  adapter: hetzner({ bucket: "uploads", region: "fsn1" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "hetzner",
    label: "Hetzner",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { akamai } from "files-sdk/akamai";

// AKAMAI_ACCESS_KEY_ID / AKAMAI_SECRET_ACCESS_KEY read from env.
const files = new Files({
  adapter: akamai({ bucket: "uploads", region: "us-iad-1" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "akamai",
    label: "Akamai",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { gcs } from "files-sdk/gcs";

const files = new Files({
  adapter: gcs({ bucket: "uploads" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "gcs",
    label: "GCS",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { googleDrive } from "files-sdk/google-drive";

// Service-account auth into a Shared Drive. Virtual keys are stored
// in the Drive file's appProperties so callers see the same
// "key in / key out" model as S3.
const files = new Files({
  adapter: googleDrive({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL!,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY!,
    },
    driveId: process.env.GOOGLE_DRIVE_ID!,
    rootFolderId: process.env.GOOGLE_DRIVE_ID!,
  }),
});

await files.upload("hello.txt", "world");
const file = await files.download("hello.txt");`,
    id: "google-drive",
    label: "Google Drive",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { azure } from "files-sdk/azure";

const files = new Files({
  adapter: azure({ container: "uploads" }),
});

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "azure",
    label: "Azure",
    lang: "tsx",
  },
  {
    code: `import { Files } from "files-sdk";
import { uploadthing } from "files-sdk/uploadthing";

// UPLOADTHING_TOKEN is read from env.
const files = new Files({ adapter: uploadthing() });

await files.upload("hello.txt", "world");
const url = await files.url("hello.txt");`,
    id: "uploadthing",
    label: "UploadThing",
    lang: "tsx",
  },
] as const;

export const Demo = () => <CodeTabs tabs={TABS} />;
