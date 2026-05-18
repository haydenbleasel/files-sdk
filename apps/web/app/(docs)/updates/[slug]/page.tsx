import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Release } from "@/components/sections/changelog";
import { getChangelog, getRelease, getReleaseSummary } from "@/lib/changelog";

interface ReleasePageProps {
  params: Promise<{ slug: string }>;
}

export const generateStaticParams = () =>
  getChangelog().map(({ slug }) => ({ slug }));

export const generateMetadata = async ({
  params,
}: ReleasePageProps): Promise<Metadata> => {
  const { slug } = await params;
  const release = getRelease(slug);

  if (!release) {
    return {};
  }

  const { headline } = getReleaseSummary(release);
  const description =
    headline.length > 200 ? `${headline.slice(0, 197)}...` : headline;

  return {
    alternates: { canonical: `/updates/${release.slug}` },
    description:
      description || `Release notes for files-sdk v${release.version}.`,
    openGraph: { url: `/updates/${release.slug}` },
    title: `v${release.version}`,
  };
};

const ReleasePage = async ({ params }: ReleasePageProps) => {
  const { slug } = await params;
  const release = getRelease(slug);

  if (!release) {
    notFound();
  }

  const { headline } = getReleaseSummary(release);

  return (
    <DocsPage>
      <DocsTitle>v{release.version}</DocsTitle>
      {headline && <DocsDescription>{headline}</DocsDescription>}
      <DocsBody>
        <Release release={release} />
      </DocsBody>
    </DocsPage>
  );
};

export default ReleasePage;
