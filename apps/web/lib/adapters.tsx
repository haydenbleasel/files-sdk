import type { ComponentType } from "react";

import { Akamai } from "@/components/sections/adapters/akamai";
import { Alibaba } from "@/components/sections/adapters/alibaba";
import { Appwrite } from "@/components/sections/adapters/appwrite";
import { Azure } from "@/components/sections/adapters/azure";
import { BackblazeB2 } from "@/components/sections/adapters/backblaze-b2";
import { Box } from "@/components/sections/adapters/box";
import { BunS3 } from "@/components/sections/adapters/bun-s3";
import { BunnyStorage } from "@/components/sections/adapters/bunny-storage";
import { Cloudinary } from "@/components/sections/adapters/cloudinary";
import { DigitalOceanSpaces } from "@/components/sections/adapters/digitalocean-spaces";
import { Dropbox } from "@/components/sections/adapters/dropbox";
import { Exoscale } from "@/components/sections/adapters/exoscale";
import { Filebase } from "@/components/sections/adapters/filebase";
import { FirebaseStorage } from "@/components/sections/adapters/firebase-storage";
import { Fs } from "@/components/sections/adapters/fs";
import { Gcs } from "@/components/sections/adapters/gcs";
import { GoogleDrive } from "@/components/sections/adapters/google-drive";
import { Hetzner } from "@/components/sections/adapters/hetzner";
import { IbmCos } from "@/components/sections/adapters/ibm-cos";
import { IdriveE2 } from "@/components/sections/adapters/idrive-e2";
import { Minio } from "@/components/sections/adapters/minio";
import { NetlifyBlobs } from "@/components/sections/adapters/netlify-blobs";
import { Onedrive } from "@/components/sections/adapters/onedrive";
import { OracleCloud } from "@/components/sections/adapters/oracle-cloud";
import { Ovhcloud } from "@/components/sections/adapters/ovhcloud";
import { Pocketbase } from "@/components/sections/adapters/pocketbase";
import { R2 } from "@/components/sections/adapters/r2";
import { S3 } from "@/components/sections/adapters/s3";
import { Scaleway } from "@/components/sections/adapters/scaleway";
import { Sharepoint } from "@/components/sections/adapters/sharepoint";
import { Storj } from "@/components/sections/adapters/storj";
import { Supabase } from "@/components/sections/adapters/supabase";
import { Tencent } from "@/components/sections/adapters/tencent";
import { Tigris } from "@/components/sections/adapters/tigris";
import { Uploadthing } from "@/components/sections/adapters/uploadthing";
import { VercelBlob } from "@/components/sections/adapters/vercel-blob";
import { Vultr } from "@/components/sections/adapters/vultr";
import { Wasabi } from "@/components/sections/adapters/wasabi";
import { Yandex } from "@/components/sections/adapters/yandex";
import type { TocSection } from "@/components/table-of-contents";

export interface Adapter {
  slug: string;
  name: string;
  description: string;
  Component: ComponentType;
  sections: TocSection[];
  /**
   * Native provider SDKs the adapter imports — listed as optional peer
   * dependencies on `files-sdk`. Empty for adapters that depend only on the
   * runtime (Bun's native S3 client, Node's `node:fs`, etc.).
   */
  peerDeps: readonly string[];
}

const INSTALL: TocSection = { id: "installation", label: "Installation" };
const OPTIONS: TocSection = { id: "options", label: "Options" };
const LIMITATIONS: TocSection = { id: "limitations", label: "Limitations" };

const AWS_S3_PEERS = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-presigned-post",
  "@aws-sdk/s3-request-presigner",
] as const;

export const ADAPTERS: Adapter[] = [
  {
    Component: S3,
    description:
      "AWS S3 (and any S3-compatible bucket). Uses the standard AWS credential chain - environment, IAM role, shared profile.",
    name: "S3",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "s3",
  },
  {
    Component: BunS3,
    description:
      "AWS S3 (and any S3-compatible bucket) via Bun's native Bun.S3Client instead of @aws-sdk/client-s3. Bun-only.",
    name: "Bun S3",
    peerDeps: [],
    sections: [OPTIONS],
    slug: "bun-s3",
  },
  {
    Component: R2,
    description:
      "Cloudflare R2 over the S3-compatible HTTP API. Auto-loads R2_* env vars or accepts an R2Bucket binding inside Workers.",
    name: "Cloudflare R2",
    peerDeps: AWS_S3_PEERS,
    sections: [{ id: "hybrid", label: "Hybrid: binding + HTTP" }],
    slug: "r2",
  },
  {
    Component: VercelBlob,
    description:
      "Vercel Blob. Prefers Vercel OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID, auto-rotating) and falls back to BLOB_READ_WRITE_TOKEN; pass token, oidcToken, or storeId manually for local dev or other hosts.",
    name: "Vercel Blob",
    peerDeps: ["@vercel/blob"],
    sections: [LIMITATIONS],
    slug: "vercel-blob",
  },
  {
    Component: NetlifyBlobs,
    description:
      "Netlify Blobs via @netlify/blobs. Auto-detects siteID and token on Netlify runtimes; falls back to env vars elsewhere.",
    name: "Netlify Blobs",
    peerDeps: ["@netlify/blobs"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "netlify-blobs",
  },
  {
    Component: Minio,
    description:
      "MinIO and other self-hosted S3-compatible servers. Path-style addressing on by default; region defaulted; errors relabelled.",
    name: "MinIO",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "minio",
  },
  {
    Component: DigitalOceanSpaces,
    description:
      "DigitalOcean Spaces via the S3-compatible API. Endpoint derived from the region, virtual-hosted addressing.",
    name: "DigitalOcean Spaces",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "digitalocean-spaces",
  },
  {
    Component: Storj,
    description:
      "Storj DCS via the S3-compatible Gateway. Defaults to the hosted Gateway MT, path-style addressing on.",
    name: "Storj",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "storj",
  },
  {
    Component: Hetzner,
    description:
      "Hetzner Object Storage via the S3-compatible API. Endpoint derived from the location code (fsn1, nbg1, hel1).",
    name: "Hetzner Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "hetzner",
  },
  {
    Component: Akamai,
    description:
      "Akamai Cloud Object Storage (formerly Linode) via the S3-compatible API. Endpoint derived from the region/cluster code.",
    name: "Akamai Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "akamai",
  },
  {
    Component: BunnyStorage,
    description:
      "Bunny Storage via @bunny.net/storage-sdk. Connects to a Storage Zone with its zone password / access key; auto-loads BUNNY_STORAGE_* env vars (STORAGE_* as aliases).",
    name: "Bunny Storage",
    peerDeps: ["@bunny.net/storage-sdk"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "bunny-storage",
  },
  {
    Component: BackblazeB2,
    description:
      "Backblaze B2 via the S3-compatible API. Endpoint derived from the cluster code (us-west-002, us-east-005, eu-central-003, ...).",
    name: "Backblaze B2",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "backblaze-b2",
  },
  {
    Component: Wasabi,
    description:
      "Wasabi Hot Cloud Storage via the S3-compatible API. AWS-style region names, Wasabi's own endpoints.",
    name: "Wasabi",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "wasabi",
  },
  {
    Component: Scaleway,
    description:
      "Scaleway Object Storage via the S3-compatible API. Endpoint derived from the region code (fr-par, nl-ams, pl-waw).",
    name: "Scaleway Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "scaleway",
  },
  {
    Component: Ovhcloud,
    description:
      "OVHcloud Object Storage (High Performance S3) via the S3-compatible API. Endpoint derived from the region code.",
    name: "OVHcloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "ovhcloud",
  },
  {
    Component: IdriveE2,
    description:
      "iDrive e2 via the S3-compatible API. Endpoint required (iDrive hostnames are tied to the cluster your bucket lives in).",
    name: "iDrive e2",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "idrive-e2",
  },
  {
    Component: Vultr,
    description:
      "Vultr Object Storage via the S3-compatible API. Endpoint derived from the region code (ewr, sjc, ams, blr, ...).",
    name: "Vultr Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "vultr",
  },
  {
    Component: Filebase,
    description:
      "Filebase via the S3-compatible API. Fronts decentralized networks (IPFS, Sia, Storj) chosen per-bucket.",
    name: "Filebase",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "filebase",
  },
  {
    Component: Exoscale,
    description:
      "Exoscale Object Storage (SOS) via the S3-compatible API. Endpoint derived from the zone code (ch-gva-2, de-fra-1, ...).",
    name: "Exoscale Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "exoscale",
  },
  {
    Component: OracleCloud,
    description:
      "Oracle Cloud Infrastructure Object Storage via the S3 compatibility layer. Auth uses HMAC Customer Secret Keys, not regular API keys.",
    name: "Oracle Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "oracle-cloud",
  },
  {
    Component: IbmCos,
    description:
      "IBM Cloud Object Storage via the S3-compatible API. Auth uses IBM Cloud HMAC credentials, not IAM API keys.",
    name: "IBM Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "ibm-cos",
  },
  {
    Component: Tencent,
    description:
      "Tencent Cloud Object Storage (COS) via the S3-compatible API. Endpoint derived from the region code; bucket name must include the -<appid> suffix.",
    name: "Tencent Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "tencent",
  },
  {
    Component: Alibaba,
    description:
      "Alibaba Cloud Object Storage Service (OSS) via the S3-compatible API. Endpoint derived from the region code (cn-hangzhou, ap-southeast-1, ...).",
    name: "Alibaba Cloud OSS",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "alibaba",
  },
  {
    Component: Tigris,
    description:
      "Tigris globally-distributed object storage via the S3-compatible API. Fixed global endpoint, region defaults to auto.",
    name: "Tigris",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "tigris",
  },
  {
    Component: Yandex,
    description:
      "Yandex Object Storage via the S3-compatible API. Fixed global endpoint, region defaults to ru-central1.",
    name: "Yandex Object Storage",
    peerDeps: AWS_S3_PEERS,
    sections: [OPTIONS],
    slug: "yandex",
  },
  {
    Component: Gcs,
    description:
      "Google Cloud Storage via the official @google-cloud/storage SDK. Application Default Credentials by default.",
    name: "Google Cloud Storage",
    peerDeps: ["@google-cloud/storage"],
    sections: [OPTIONS],
    slug: "gcs",
  },
  {
    Component: FirebaseStorage,
    description:
      "Firebase Cloud Storage via the official firebase-admin SDK. Underlying client is @google-cloud/storage, so V4 signed URLs and POST policy uploads come for free.",
    name: "Firebase Storage",
    peerDeps: ["firebase-admin"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "firebase-storage",
  },
  {
    Component: GoogleDrive,
    description:
      "Google Drive via the official Drive v3 client. Maps unified string keys onto Drive's appProperties with a per-instance LRU cache.",
    name: "Google Drive",
    peerDeps: ["@googleapis/drive", "google-auth-library"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "google-drive",
  },
  {
    Component: Onedrive,
    description:
      "OneDrive and SharePoint document libraries via Microsoft Graph. Path-addressable, no virtual-key bookkeeping.",
    name: "OneDrive",
    peerDeps: ["@azure/identity", "@microsoft/microsoft-graph-client"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "onedrive",
  },
  {
    Component: Dropbox,
    description:
      "Dropbox via the official SDK. Path-addressable, virtual keys map directly to Dropbox paths - no cache.",
    name: "Dropbox",
    peerDeps: ["dropbox"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "dropbox",
  },
  {
    Component: Box,
    description:
      "Box via the official typed SDK. Translates virtual keys into nested folders under a configurable rootFolderId.",
    name: "Box",
    peerDeps: ["box-typescript-sdk-gen"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "box",
  },
  {
    Component: Azure,
    description:
      "Azure Blob Storage via @azure/storage-blob. Four credential modes - connection string, account key, SAS token, or anonymous.",
    name: "Azure Blob Storage",
    peerDeps: ["@azure/storage-blob"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "azure",
  },
  {
    Component: Supabase,
    description:
      "Supabase Storage via @supabase/storage-js. Pass an existing SupabaseClient to share auth/postgrest with the rest of your app.",
    name: "Supabase Storage",
    peerDeps: ["@supabase/storage-js"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "supabase",
  },
  {
    Component: Uploadthing,
    description:
      "UploadThing via uploadthing/server. Maps user-supplied keys onto UploadThing's customId.",
    name: "UploadThing",
    peerDeps: ["uploadthing"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "uploadthing",
  },
  {
    Component: Fs,
    description:
      "Local filesystem - the dev/test adapter. Uses node:fs/promises with a sidecar .meta.json per file. Not for production.",
    name: "Filesystem",
    peerDeps: [],
    sections: [
      OPTIONS,
      { id: "storage-layout", label: "Storage layout" },
      LIMITATIONS,
    ],
    slug: "fs",
  },
  {
    Component: Appwrite,
    description:
      "Appwrite Storage via the official Node.js SDK. Auto-loads configuration from environment variables.",
    name: "Appwrite",
    peerDeps: ["node-appwrite"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "appwrite",
  },
  {
    Component: Pocketbase,
    description:
      "PocketBase via the official JS SDK. Maps the unified key/blob API onto a dedicated collection with a unique key field and a single-file body field.",
    name: "PocketBase",
    peerDeps: ["pocketbase"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "pocketbase",
  },
  {
    Component: Cloudinary,
    description:
      "Cloudinary asset CDN via the official Node SDK. Defaults to resource_type: raw for arbitrary-bytes storage; switch to image/video for transforms.",
    name: "Cloudinary",
    peerDeps: ["cloudinary"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "cloudinary",
  },
  {
    Component: Sharepoint,
    description:
      "SharePoint document libraries via Microsoft Graph. Resolves siteUrl and library names; delegates to the OneDrive adapter for the file operations.",
    name: "SharePoint",
    peerDeps: ["@azure/identity", "@microsoft/microsoft-graph-client"],
    sections: [OPTIONS, LIMITATIONS],
    slug: "sharepoint",
  },
];

export const ADAPTERS_BY_SLUG = new Map<string, Adapter>(
  ADAPTERS.map((adapter) => [adapter.slug, adapter])
);

export const getAdapter = (slug: string): Adapter | undefined => {
  const adapter = ADAPTERS_BY_SLUG.get(slug);
  if (!adapter) {
    return undefined;
  }
  return { ...adapter, sections: [INSTALL, ...adapter.sections] };
};
