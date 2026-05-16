import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { AdaptersIndex } from "@/components/sections/adapters-index";
import { PageHero } from "@/components/sections/page-hero";
import { ADAPTERS } from "@/lib/adapters";

const indexEntries = ADAPTERS.map(({ slug, name, description }) => ({
  description,
  name,
  slug,
}));

export const metadata: Metadata = {
  alternates: { canonical: "/adapters" },
  description:
    "Adapters for every supported provider - S3, R2, Vercel Blob, Netlify Blobs, MinIO, GCS, Azure, Supabase, Google Drive, Dropbox, and more.",
  openGraph: { url: "/adapters" },
  title: "Adapters",
};

const AdaptersPage = () => (
  <>
    <PageHero
      title="Adapters"
      description="Subpath imports per provider - tree-shake what you don't use. Credentials auto-load from standard env vars; missing ones throw at construction with the variable name."
    />
    <FadeIn>
      <AdaptersIndex adapters={indexEntries} />
    </FadeIn>
  </>
);

export default AdaptersPage;
