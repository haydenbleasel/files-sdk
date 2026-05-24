import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageActions } from "@/components/page-actions";
import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const githubContentBase =
  "https://github.com/haydenbleasel/files-sdk/blob/main/apps/web/content/docs";

interface PageProps {
  params: Promise<{ slug: string[] }>;
}

const Page = async ({ params }: PageProps) => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const markdown = await getLLMText(page);
  const markdownUrl = `${page.url}.md`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle className="font-semibold tracking-tight">
        {page.data.title}
      </DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <PageActions
        githubUrl={`${githubContentBase}/${page.path}`}
        markdown={markdown}
        markdownAbsoluteUrl={`${baseUrl}${markdownUrl}`}
        markdownUrl={markdownUrl}
      />
      <DocsBody className="[&_h2]:tracking-tight [&_h3]:tracking-tight [&_h4]:tracking-tight">
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
};

export default Page;

export const generateStaticParams = () => source.generateParams();

export const generateMetadata = async ({
  params,
}: PageProps): Promise<Metadata> => {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    notFound();
  }

  const ogImage = {
    alt: page.data.title,
    height: 630,
    url: `/og/${slug.join("/")}`,
    width: 1200,
  };

  return {
    alternates: {
      canonical: page.url,
    },
    description: page.data.description,
    openGraph: {
      description: page.data.description,
      images: [ogImage],
      siteName: "Files SDK",
      title: page.data.title,
      type: "article",
      url: page.url,
    },
    title: page.data.title,
    twitter: {
      card: "summary_large_image",
      description: page.data.description,
      images: [ogImage],
      title: page.data.title,
    },
  };
};
