import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Release } from "@/components/sections/changelog";
import { getChangelog, getRelease } from "@/lib/changelog";

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

  return {
    alternates: { canonical: `/updates/${release.slug}` },
    description: `Release notes for files-sdk v${release.version}.`,
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

  return (
    <DocsPage>
      <DocsTitle>v{release.version}</DocsTitle>
      <DocsBody>
        <Release release={release} />
      </DocsBody>
    </DocsPage>
  );
};

export default ReleasePage;
