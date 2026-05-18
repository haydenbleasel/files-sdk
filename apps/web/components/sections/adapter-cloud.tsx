import { ArrowRight } from "lucide-react";
import Link from "next/link";

import * as icons from "./icons";

const ICON_META: Record<keyof typeof icons, { label: string; slug: string }> = {
  AzureBlobStorage: { label: "Azure Blob Storage", slug: "azure" },
  Box: { label: "Box", slug: "box" },
  DigitalOcean: { label: "DigitalOcean Spaces", slug: "digitalocean-spaces" },
  Dropbox: { label: "Dropbox", slug: "dropbox" },
  GoogleCloudStorage: { label: "Google Cloud Storage", slug: "gcs" },
  GoogleDrive: { label: "Google Drive", slug: "google-drive" },
  Minio: { label: "MinIO", slug: "minio" },
  NetlifyBlobs: { label: "Netlify Blobs", slug: "netlify-blobs" },
  OneDrive: { label: "OneDrive", slug: "onedrive" },
  R2: { label: "Cloudflare R2", slug: "r2" },
  S3: { label: "Amazon S3", slug: "s3" },
  Supabase: { label: "Supabase Storage", slug: "supabase" },
  UploadThing: { label: "UploadThing", slug: "uploadthing" },
  Vercel: { label: "Vercel Blob", slug: "vercel-blob" },
};

const adapters = Object.entries(icons) as [
  keyof typeof icons,
  (typeof icons)[keyof typeof icons],
][];

export const AdapterCloud = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            40+ adapters
          </p>
          <h2 className="mt-3 max-w-[24ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
            Bring whatever storage you already have.
          </h2>
        </div>
        <Link
          href="/adapters"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-muted-foreground"
        >
          See all adapters
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <ul
        className="mt-14 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 lg:grid-cols-4"
        role="list"
      >
        {adapters.map(([key, Icon]) => {
          const { label, slug } = ICON_META[key];
          return (
            <li key={key}>
              <Link
                href={`/adapters/${slug}`}
                className="group flex items-center gap-3 text-foreground"
              >
                <Icon className="size-7 shrink-0 rounded opacity-60 grayscale transition duration-300 group-hover:opacity-100 group-hover:grayscale-0" />
                <span className="truncate text-sm font-medium transition-colors group-hover:text-muted-foreground">
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
        <li className="hidden lg:block">
          <Link
            href="/adapters"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            + 26 more
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </li>
      </ul>
    </div>
  </section>
);
