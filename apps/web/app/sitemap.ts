import type { MetadataRoute } from "next";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const routes: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/adapters", priority: 0.9 },
  { path: "/api", priority: 0.9 },
  { path: "/ai", priority: 0.8 },
  { path: "/updates", priority: 0.7 },
];

const sitemap = (): MetadataRoute.Sitemap =>
  routes.map(({ path, priority }) => ({
    changeFrequency: "weekly",
    lastModified: new Date(),
    priority,
    url: `${baseUrl}${path}`,
  }));

export default sitemap;
