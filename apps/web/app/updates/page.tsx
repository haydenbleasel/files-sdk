import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { PageHero } from "@/components/sections/page-hero";
import { UpdatesIndex } from "@/components/sections/updates-index";
import { getChangelog, getReleaseSummary } from "@/lib/changelog";

export const metadata: Metadata = {
  alternates: { canonical: "/updates" },
  description:
    "Release notes for Files SDK — every published version, parsed straight from the package changelog.",
  openGraph: { url: "/updates" },
  title: "Updates",
};

const UpdatesPage = () => {
  const releases = getChangelog().map(getReleaseSummary);

  return (
    <>
      <PageHero
        title="Updates"
        description="What shipped in each release of files-sdk. Pulled and parsed straight from the package CHANGELOG.md, so this page is whatever the registry has."
      />
      <FadeIn>
        <UpdatesIndex releases={releases} />
      </FadeIn>
    </>
  );
};

export default UpdatesPage;
