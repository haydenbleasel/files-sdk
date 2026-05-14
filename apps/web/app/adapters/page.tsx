import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { Adapters } from "@/components/sections/adapters";
import { PageHero } from "@/components/sections/page-hero";
import { ADAPTER_SECTIONS, flattenSections } from "@/lib/sections";

const mobileSections = flattenSections(ADAPTER_SECTIONS);

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
    <FadeIn className="lg:hidden">
      <MobileTableOfContents sections={mobileSections} />
    </FadeIn>
    <FadeIn>
      <Adapters />
    </FadeIn>
  </>
);

export default AdaptersPage;
