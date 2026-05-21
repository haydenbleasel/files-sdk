export interface Adapter {
  slug: string;
  name: string;
  description: string;
  /**
   * Native provider SDKs the adapter imports — listed as optional peer
   * dependencies on `files-sdk`. Empty for adapters that depend only on the
   * runtime (Bun's native S3 client, Node's `node:fs`, etc.).
   */
  peerDeps: readonly string[];
}

const AWS_S3_PEERS = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-presigned-post",
  "@aws-sdk/s3-request-presigner",
] as const;

export const ADAPTERS: Adapter[] = [
  {
    description:
      "AWS S3 (and any S3-compatible bucket). Uses the standard AWS credential chain - environment, IAM role, shared profile.",
    name: "S3",
    peerDeps: AWS_S3_PEERS,
    slug: "s3",
  },
  {
    description:
      "AWS S3 (and any S3-compatible bucket) via Bun's native Bun.S3Client instead of @aws-sdk/client-s3. Bun-only.",
    name: "Bun S3",
    peerDeps: [],
    slug: "bun-s3",
  },
  {
    description:
      "Cloudflare R2 over the S3-compatible HTTP API. Auto-loads R2_* env vars or accepts an R2Bucket binding inside Workers.",
    name: "Cloudflare R2",
    peerDeps: AWS_S3_PEERS,
    slug: "r2",
  },
  {
    description:
      "Vercel Blob. Prefers Vercel OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID, auto-rotating) and falls back to BLOB_READ_WRITE_TOKEN; pass token, oidcToken, or storeId manually for local dev or other hosts.",
    name: "Vercel Blob",
    peerDeps: ["@vercel/blob"],
    slug: "vercel-blob",
  },
  {
    description:
      "Netlify Blobs via @netlify/blobs. Auto-detects siteID and token on Netlify runtimes; falls back to env vars elsewhere.",
    name: "Netlify Blobs",
    peerDeps: ["@netlify/blobs"],
    slug: "netlify-blobs",
  },
  {
    description:
      "MinIO and other self-hosted S3-compatible servers. Path-style addressing on by default; region defaulted; errors relabelled.",
    name: "MinIO",
    peerDeps: AWS_S3_PEERS,
    slug: "minio",
  },
  {
    description:
      "DigitalOcean Spaces via the S3-compatible API. Endpoint derived from the region, virtual-hosted addressing.",
    name: "DigitalOcean Spaces",
    peerDeps: AWS_S3_PEERS,
    slug: "digitalocean-spaces",
  },
  {
    description:
      "Storj DCS via the S3-compatible Gateway. Defaults to the hosted Gateway MT, path-style addressing on.",
    name: "Storj",
    peerDeps: AWS_S3_PEERS,
    slug: "storj",
  },
  {
    description:
      "Hetzner Object Storage via the S3-compatible API. Endpoint derived from the location code (fsn1, nbg1, hel1).",
    name: "Hetzner Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "hetzner",
  },
  {
    description:
      "Akamai Cloud Object Storage (formerly Linode) via the S3-compatible API. Endpoint derived from the region/cluster code.",
    name: "Akamai Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "akamai",
  },
  {
    description:
      "Bunny Storage via @bunny.net/storage-sdk. Connects to a Storage Zone with its zone password / access key; auto-loads BUNNY_STORAGE_* env vars (STORAGE_* as aliases).",
    name: "Bunny Storage",
    peerDeps: ["@bunny.net/storage-sdk"],
    slug: "bunny-storage",
  },
  {
    description:
      "Backblaze B2 via the S3-compatible API. Endpoint derived from the cluster code (us-west-002, us-east-005, eu-central-003, ...).",
    name: "Backblaze B2",
    peerDeps: AWS_S3_PEERS,
    slug: "backblaze-b2",
  },
  {
    description:
      "Wasabi Hot Cloud Storage via the S3-compatible API. AWS-style region names, Wasabi's own endpoints.",
    name: "Wasabi",
    peerDeps: AWS_S3_PEERS,
    slug: "wasabi",
  },
  {
    description:
      "Scaleway Object Storage via the S3-compatible API. Endpoint derived from the region code (fr-par, nl-ams, pl-waw).",
    name: "Scaleway Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "scaleway",
  },
  {
    description:
      "OVHcloud Object Storage (High Performance S3) via the S3-compatible API. Endpoint derived from the region code.",
    name: "OVHcloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "ovhcloud",
  },
  {
    description:
      "iDrive e2 via the S3-compatible API. Endpoint required (iDrive hostnames are tied to the cluster your bucket lives in).",
    name: "iDrive e2",
    peerDeps: AWS_S3_PEERS,
    slug: "idrive-e2",
  },
  {
    description:
      "Vultr Object Storage via the S3-compatible API. Endpoint derived from the region code (ewr, sjc, ams, blr, ...).",
    name: "Vultr Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "vultr",
  },
  {
    description:
      "Filebase via the S3-compatible API. Fronts decentralized networks (IPFS, Sia, Storj) chosen per-bucket.",
    name: "Filebase",
    peerDeps: AWS_S3_PEERS,
    slug: "filebase",
  },
  {
    description:
      "Exoscale Object Storage (SOS) via the S3-compatible API. Endpoint derived from the zone code (ch-gva-2, de-fra-1, ...).",
    name: "Exoscale Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "exoscale",
  },
  {
    description:
      "Oracle Cloud Infrastructure Object Storage via the S3 compatibility layer. Auth uses HMAC Customer Secret Keys, not regular API keys.",
    name: "Oracle Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "oracle-cloud",
  },
  {
    description:
      "IBM Cloud Object Storage via the S3-compatible API. Auth uses IBM Cloud HMAC credentials, not IAM API keys.",
    name: "IBM Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "ibm-cos",
  },
  {
    description:
      "Tencent Cloud Object Storage (COS) via the S3-compatible API. Endpoint derived from the region code; bucket name must include the -<appid> suffix.",
    name: "Tencent Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "tencent",
  },
  {
    description:
      "Alibaba Cloud Object Storage Service (OSS) via the S3-compatible API. Endpoint derived from the region code (cn-hangzhou, ap-southeast-1, ...).",
    name: "Alibaba Cloud OSS",
    peerDeps: AWS_S3_PEERS,
    slug: "alibaba",
  },
  {
    description:
      "Tigris globally-distributed object storage via the S3-compatible API. Fixed global endpoint, region defaults to auto.",
    name: "Tigris",
    peerDeps: AWS_S3_PEERS,
    slug: "tigris",
  },
  {
    description:
      "Yandex Object Storage via the S3-compatible API. Fixed global endpoint, region defaults to ru-central1.",
    name: "Yandex Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "yandex",
  },
  {
    description:
      "Google Cloud Storage via the official @google-cloud/storage SDK. Application Default Credentials by default.",
    name: "Google Cloud Storage",
    peerDeps: ["@google-cloud/storage"],
    slug: "gcs",
  },
  {
    description:
      "Firebase Cloud Storage via the official firebase-admin SDK. Underlying client is @google-cloud/storage, so V4 signed URLs and POST policy uploads come for free.",
    name: "Firebase Storage",
    peerDeps: ["firebase-admin"],
    slug: "firebase-storage",
  },
  {
    description:
      "Google Drive via the official Drive v3 client. Maps unified string keys onto Drive's appProperties with a per-instance LRU cache.",
    name: "Google Drive",
    peerDeps: ["@googleapis/drive", "google-auth-library"],
    slug: "google-drive",
  },
  {
    description:
      "OneDrive and SharePoint document libraries via Microsoft Graph. Path-addressable, no virtual-key bookkeeping.",
    name: "OneDrive",
    peerDeps: ["@azure/identity", "@microsoft/microsoft-graph-client"],
    slug: "onedrive",
  },
  {
    description:
      "Dropbox via the official SDK. Path-addressable, virtual keys map directly to Dropbox paths - no cache.",
    name: "Dropbox",
    peerDeps: ["dropbox"],
    slug: "dropbox",
  },
  {
    description:
      "Box via the official typed SDK. Translates virtual keys into nested folders under a configurable rootFolderId.",
    name: "Box",
    peerDeps: ["box-typescript-sdk-gen"],
    slug: "box",
  },
  {
    description:
      "Azure Blob Storage via @azure/storage-blob. Four credential modes - connection string, account key, SAS token, or anonymous.",
    name: "Azure Blob Storage",
    peerDeps: ["@azure/storage-blob"],
    slug: "azure",
  },
  {
    description:
      "Supabase Storage via @supabase/storage-js. Pass an existing SupabaseClient to share auth/postgrest with the rest of your app.",
    name: "Supabase Storage",
    peerDeps: ["@supabase/storage-js"],
    slug: "supabase",
  },
  {
    description:
      "UploadThing via uploadthing/server. Maps user-supplied keys onto UploadThing's customId.",
    name: "UploadThing",
    peerDeps: ["uploadthing"],
    slug: "uploadthing",
  },
  {
    description:
      "Local filesystem - the dev/test adapter. Uses node:fs/promises with a sidecar .meta.json per file. Not for production.",
    name: "Filesystem",
    peerDeps: [],
    slug: "fs",
  },
  {
    description:
      "Appwrite Storage via the official Node.js SDK. Auto-loads configuration from environment variables.",
    name: "Appwrite",
    peerDeps: ["node-appwrite"],
    slug: "appwrite",
  },
  {
    description:
      "PocketBase via the official JS SDK. Maps the unified key/blob API onto a dedicated collection with a unique key field and a single-file body field.",
    name: "PocketBase",
    peerDeps: ["pocketbase"],
    slug: "pocketbase",
  },
  {
    description:
      "Cloudinary asset CDN via the official Node SDK. Defaults to resource_type: raw for arbitrary-bytes storage; switch to image/video for transforms.",
    name: "Cloudinary",
    peerDeps: ["cloudinary"],
    slug: "cloudinary",
  },
  {
    description:
      "SharePoint document libraries via Microsoft Graph. Resolves siteUrl and library names; delegates to the OneDrive adapter for the file operations.",
    name: "SharePoint",
    peerDeps: ["@azure/identity", "@microsoft/microsoft-graph-client"],
    slug: "sharepoint",
  },
];
