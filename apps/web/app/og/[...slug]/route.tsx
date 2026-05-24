import { renderOgImage } from "@/lib/og/og-image";
import { source } from "@/lib/source";

interface RouteProps {
  params: Promise<{ slug?: string[] }>;
}

export const GET = async (_request: Request, { params }: RouteProps) => {
  const { slug } = await params;
  const page = source.getPage(slug);

  return renderOgImage({
    description: page?.data.description ?? "",
    title: page?.data.title ?? "Files SDK",
  });
};

export const generateStaticParams = () => source.generateParams();

// Only the docs slugs above have OG images; anything else 404s rather than
// trying to render on-demand (where the build-time font read wouldn't apply).
export const dynamicParams = false;
