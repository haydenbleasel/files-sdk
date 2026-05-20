import type { MetadataRoute } from "next";

import { source } from "@/lib/source";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const STATIC_ROUTES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
];

const priorityForDocsUrl = (url: string): number => {
  if (url === "/adapters" || url === "/api") {
    return 0.9;
  }
  if (url === "/cli" || url === "/ai") {
    return 0.8;
  }
  // ai sub-pages (e.g. /ai/openai)
  if (url.startsWith("/ai/")) {
    return 0.7;
  }
  // adapter detail pages (e.g. /adapters/s3)
  return 0.6;
};

const sitemap = (): MetadataRoute.Sitemap => {
  const docsRoutes = source.getPages().map((page) => ({
    path: page.url,
    priority: priorityForDocsUrl(page.url),
  }));

  return [...STATIC_ROUTES, ...docsRoutes].map(({ path, priority }) => ({
    changeFrequency: "weekly" as const,
    lastModified: new Date(),
    priority,
    url: `${baseUrl}${path}`,
  }));
};

export default sitemap;
