import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { Changelog } from "@/components/sections/changelog";
import { PageHero } from "@/components/sections/page-hero";
import { getChangelog } from "@/lib/changelog";

export const metadata: Metadata = {
  alternates: { canonical: "/updates" },
  description:
    "Release notes for Files SDK — every published version, parsed straight from the package changelog.",
  openGraph: { url: "/updates" },
  title: "Updates",
};

const UpdatesPage = () => {
  const releases = getChangelog();
  const mobileSections = releases.map((release) => ({
    id: release.slug,
    label: `v${release.version}`,
  }));

  return (
    <>
      <PageHero
        title="Updates"
        description="What shipped in each release of files-sdk. Pulled and parsed straight from the package CHANGELOG.md, so this page is whatever the registry has."
      />
      <FadeIn className="lg:hidden">
        <MobileTableOfContents sections={mobileSections} />
      </FadeIn>
      <FadeIn>
        <Changelog />
      </FadeIn>
    </>
  );
};

export default UpdatesPage;
