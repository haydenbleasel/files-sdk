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
    label: "Cloudflare R2",
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
] as const;

export const Demo = () => <CodeTabs tabs={TABS} />;
