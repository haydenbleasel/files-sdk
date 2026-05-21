import { notFound } from "next/navigation";

import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

interface RouteProps {
  params: Promise<{ slug?: string[] }>;
}

export const revalidate = false;

export const GET = async (_request: Request, { params }: RouteProps) => {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown",
    },
  });
};

export const generateStaticParams = () => source.generateParams();
