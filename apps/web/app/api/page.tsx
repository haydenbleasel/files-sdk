import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { ApiReference } from "@/components/sections/api-reference";
import { Errors } from "@/components/sections/errors";
import { EscapeHatch } from "@/components/sections/escape-hatch";
import { PageHero } from "@/components/sections/page-hero";
import { StoredFileType } from "@/components/sections/stored-file-type";
import { API_SECTIONS, flattenSections } from "@/lib/sections";

const mobileSections = flattenSections(API_SECTIONS);

export const metadata: Metadata = {
  alternates: { canonical: "/api" },
  description:
    "The full Files SDK API - eight unified methods, the StoredFile type, normalized errors, and the escape hatch to the native client.",
  openGraph: { url: "/api" },
  title: "API reference",
};

const ApiPage = () => (
  <>
    <PageHero
      title="API reference"
      description="Every method is available on the Files instance. The unified surface only covers what every adapter can do cleanly - anything provider-specific lives on files.raw."
    />
    <FadeIn className="lg:hidden">
      <MobileTableOfContents sections={mobileSections} />
    </FadeIn>
    <FadeIn>
      <ApiReference />
    </FadeIn>
    <FadeIn>
      <StoredFileType />
    </FadeIn>
    <FadeIn>
      <Errors />
    </FadeIn>
    <FadeIn>
      <EscapeHatch />
    </FadeIn>
  </>
);

export default ApiPage;
