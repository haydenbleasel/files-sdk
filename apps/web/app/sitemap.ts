import type { MetadataRoute } from "next";

import { ADAPTERS } from "@/lib/adapters";
import { getChangelog } from "@/lib/changelog";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const baseUrl = `${protocol}://${origin}`;

const routes: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/adapters", priority: 0.9 },
  { path: "/api", priority: 0.9 },
  { path: "/ai", priority: 0.8 },
  { path: "/cli", priority: 0.8 },
  { path: "/updates", priority: 0.7 },
  ...ADAPTERS.map(({ slug }) => ({
    path: `/adapters/${slug}`,
    priority: 0.6,
  })),
  ...getChangelog().map(({ slug }) => ({
    path: `/updates/${slug}`,
    priority: 0.5,
  })),
];

const sitemap = (): MetadataRoute.Sitemap =>
  routes.map(({ path, priority }) => ({
    changeFrequency: "weekly",
    lastModified: new Date(),
    priority,
    url: `${baseUrl}${path}`,
  }));

export default sitemap;
