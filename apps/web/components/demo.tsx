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
  {
    config: `digitaloceanSpaces({ bucket: "uploads", region: "nyc3" })`,
    id: "digitalocean-spaces",
    import: `import { digitaloceanSpaces } from "files-sdk/digitalocean-spaces";`,
    label: "DigitalOcean Spaces",
  },
  {
    config: `storj({ bucket: "uploads" })`,
    id: "storj",
    import: `import { storj } from "files-sdk/storj";`,
    label: "Storj",
  },
  {
    config: `hetzner({ bucket: "uploads", region: "fsn1" })`,
    id: "hetzner",
    import: `import { hetzner } from "files-sdk/hetzner";`,
    label: "Hetzner",
  },
  {
    config: `akamai({ bucket: "uploads", region: "us-iad-1" })`,
    id: "akamai",
    import: `import { akamai } from "files-sdk/akamai";`,
    label: "Akamai",
  },
  {
    config: `backblazeB2({ bucket: "uploads", region: "us-west-002" })`,
    id: "backblaze-b2",
    import: `import { backblazeB2 } from "files-sdk/backblaze-b2";`,
    label: "Backblaze B2",
  },
  {
    config: `wasabi({ bucket: "uploads", region: "us-east-1" })`,
    id: "wasabi",
    import: `import { wasabi } from "files-sdk/wasabi";`,
    label: "Wasabi",
  },
  {
    config: `tigris({ bucket: "uploads" })`,
    id: "tigris",
    import: `import { tigris } from "files-sdk/tigris";`,
    label: "Tigris",
  },
  {
    config: `gcs({ bucket: "uploads" })`,
    id: "gcs",
    import: `import { gcs } from "files-sdk/gcs";`,
    label: "GCS",
  },
  {
    config: `googleDrive()`,
    id: "google-drive",
    import: `import { googleDrive } from "files-sdk/google-drive";`,
    label: "Google Drive",
  },
  {
    config: `azure({ container: "uploads" })`,
    id: "azure",
    import: `import { azure } from "files-sdk/azure";`,
    label: "Azure",
  },
  {
    config: `onedrive()`,
    id: "onedrive",
    import: `import { onedrive } from "files-sdk/onedrive";`,
    label: "OneDrive",
  },
  {
    config: `supabase({ bucket: "uploads" })`,
    id: "supabase",
    import: `import { supabase } from "files-sdk/supabase";`,
    label: "Supabase",
  },
  {
    config: `dropbox()`,
    id: "dropbox",
    import: `import { dropbox } from "files-sdk/dropbox";`,
    label: "Dropbox",
  },
  {
    config: `box()`,
    id: "box",
    import: `import { box } from "files-sdk/box";`,
    label: "Box",
  },
  {
    config: `uploadthing()`,
    id: "uploadthing",
    import: `import { uploadthing } from "files-sdk/uploadthing";`,
    label: "UploadThing",
  },
  {
    config: `fs({ root: "./uploads" })`,
    id: "fs",
    import: `import { fs } from "files-sdk/fs";`,
    label: "Filesystem",
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
