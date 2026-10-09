// A memory-backed adapter that reports another provider's `name` and the
// notification format that provider's adapter declares, so the events tests
// can exercise each format without the provider's SDK.
import type { Adapter, EventFormat } from "../src/index.js";
import { memory } from "../src/memory/index.js";

const FORMATS: Readonly<Record<string, EventFormat>> = {
  appwrite: "appwrite",
  azure: "azure",
  "backblaze-b2": "b2",
  box: "box",
  cloudinary: "cloudinary",
  "firebase-storage": "gcs",
  gcs: "gcs",
  memory: "memory",
  minio: "s3",
  "minio-fetch": "s3",
  r2: "r2",
  "r2-binding": "r2",
  rustfs: "s3",
  s3: "s3",
  storj: "s3",
  supabase: "supabase",
  tigris: "tigris",
  wasabi: "s3",
};

export const providerAdapter = (
  name: string,
  extra: Record<string, unknown> = {}
): Adapter => {
  const base = memory();
  const format = FORMATS[name];
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      events: format ? { format } : false,
    },
    name,
    ...extra,
  } as Adapter;
};
