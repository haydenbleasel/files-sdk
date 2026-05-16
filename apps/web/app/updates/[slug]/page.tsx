import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FadeIn } from "@/components/fade-in";
import { Release } from "@/components/sections/changelog";
import { PageHero } from "@/components/sections/page-hero";
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

  return (
    <>
      <PageHero title={`v${release.version}`} />
      <FadeIn>
        <Release release={release} />
      </FadeIn>
    </>
  );
};

export default ReleasePage;
