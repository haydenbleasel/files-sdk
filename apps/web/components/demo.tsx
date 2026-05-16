import { CodeTabs } from "./code-tabs";

const ADAPTERS = [
  {
    config: `s3({ bucket: "uploads", region: "us-east-1" })`,
    id: "s3",
    import: `import { s3 } from "files-sdk/s3";`,
    label: "S3",
  },
  {
    config: `r2({ bucket: "uploads", accountId: "..." })`,
    id: "r2",
    import: `import { r2 } from "files-sdk/r2";`,
    label: "R2",
  },
  {
    config: `vercelBlob()`,
    id: "vercel-blob",
    import: `import { vercelBlob } from "files-sdk/vercel-blob";`,
    label: "Vercel Blob",
  },
  {
    config: `netlifyBlobs({ name: "uploads" })`,
    id: "netlify-blobs",
    import: `import { netlifyBlobs } from "files-sdk/netlify-blobs";`,
    label: "Netlify Blobs",
  },
  {
    config: `minio({ bucket: "uploads", endpoint: "http://localhost:9000" })`,
    id: "minio",
    import: `import { minio } from "files-sdk/minio";`,
    label: "MinIO",
  },
] as const;

const buildCode = (adapter: (typeof ADAPTERS)[number]) =>
  `import { Files } from "files-sdk";
${adapter.import}

const files = new Files({
  adapter: ${adapter.config},
});

await files.upload("hello.txt", "world");
const file = await files.download("hello.txt");
const meta = await files.head("hello.txt");
const items = await files.list();
await files.delete("hello.txt");`;

const TABS = ADAPTERS.map((adapter) => ({
  code: buildCode(adapter),
  id: adapter.id,
  label: adapter.label,
  lang: "tsx" as const,
}));

export const Demo = () => <CodeTabs tabs={TABS} />;
