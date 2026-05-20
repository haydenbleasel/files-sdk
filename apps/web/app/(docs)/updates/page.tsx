import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import type { Metadata } from "next";

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
    <DocsPage>
      <DocsTitle>Updates</DocsTitle>
      <DocsDescription>
        What shipped in each release of files-sdk. Pulled and parsed straight
        from the package CHANGELOG.md, so this page is whatever the registry
        has.
      </DocsDescription>
      <DocsBody className="not-prose">
        <UpdatesIndex releases={releases} />
      </DocsBody>
    </DocsPage>
  );
};

export default UpdatesPage;
