import type { TocSection } from "@/components/table-of-contents";

export const HOME_SECTIONS: TocSection[] = [
  { id: "why", label: "Why" },
  { id: "installation", label: "Installation" },
  { id: "quick-start", label: "Quick start" },
  { id: "compatibility-matrix", label: "Compatibility matrix" },
];

export const ADAPTER_SECTIONS: TocSection[] = [
  { id: "adapter-s3", label: "S3" },
  { id: "adapter-r2", label: "Cloudflare R2" },
  { id: "adapter-vercel-blob", label: "Vercel Blob" },
  { id: "adapter-netlify-blobs", label: "Netlify Blobs" },
  { id: "adapter-minio", label: "MinIO" },
  { id: "adapter-digitalocean-spaces", label: "DigitalOcean Spaces" },
  { id: "adapter-storj", label: "Storj" },
  { id: "adapter-hetzner", label: "Hetzner" },
  { id: "adapter-akamai", label: "Akamai Object Storage" },
  { id: "adapter-backblaze-b2", label: "Backblaze B2" },
  { id: "adapter-wasabi", label: "Wasabi" },
  { id: "adapter-scaleway", label: "Scaleway" },
  { id: "adapter-ovhcloud", label: "OVHcloud" },
  { id: "adapter-idrive-e2", label: "iDrive e2" },
  { id: "adapter-vultr", label: "Vultr" },
  { id: "adapter-filebase", label: "Filebase" },
  { id: "adapter-exoscale", label: "Exoscale" },
  { id: "adapter-oracle-cloud", label: "Oracle Cloud" },
  { id: "adapter-ibm-cos", label: "IBM Cloud Object Storage" },
  { id: "adapter-tigris", label: "Tigris" },
  { id: "adapter-gcs", label: "Google Cloud Storage" },
  { id: "adapter-google-drive", label: "Google Drive" },
  { id: "adapter-onedrive", label: "OneDrive" },
  { id: "adapter-dropbox", label: "Dropbox" },
  { id: "adapter-box", label: "Box" },
  { id: "adapter-azure", label: "Azure Blob Storage" },
  { id: "adapter-supabase", label: "Supabase Storage" },
  { id: "adapter-uploadthing", label: "UploadThing" },
  { id: "adapter-fs", label: "Filesystem" },
];

export const AI_SECTIONS: TocSection[] = [
  { id: "openai-tools", label: "OpenAI" },
  { id: "ai-sdk-tools", label: "Vercel AI SDK" },
  { id: "claude-tools", label: "Claude Agent SDK" },
];

export const API_SECTIONS: TocSection[] = [
  {
    children: [
      { id: "files-upload", label: "upload" },
      { id: "files-download", label: "download" },
      { id: "files-head", label: "head" },
      { id: "files-delete", label: "delete" },
      { id: "files-copy", label: "copy" },
      { id: "files-list", label: "list" },
      { id: "files-url", label: "url" },
      { id: "files-signed-upload-url", label: "signedUploadUrl" },
    ],
    id: "functions",
    label: "Functions",
  },
  { id: "the-storedfile-type", label: "The StoredFile type" },
  { id: "errors", label: "Errors" },
  { id: "escape-hatch", label: "Escape hatch" },
];

export const flattenSections = (
  sections: TocSection[]
): { id: string; label: string }[] =>
  sections.flatMap(({ id, label, children }) => [
    { id, label },
    ...(children ?? []),
  ]);
