import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  redirects: () => [
    {
      destination: "/overview",
      permanent: true,
      source: "/docs",
    },
    {
      destination: "/adapters/s3",
      permanent: false,
      source: "/adapters",
    },
    {
      destination: "/ai/openai",
      permanent: false,
      source: "/ai",
    },
    {
      destination: "/api/transfer",
      permanent: true,
      source: "/features/transfer",
    },
    {
      destination: "/api/onaction",
      permanent: true,
      source: "/features",
    },
    {
      destination: "/api/onaction",
      permanent: true,
      source: "/features/onaction",
    },
    {
      destination: "/api/onerror",
      permanent: true,
      source: "/features/onerror",
    },
    {
      destination: "/api/onretry",
      permanent: true,
      source: "/features/onretry",
    },
    {
      destination: "/api/onprogress",
      permanent: true,
      source: "/features/onprogress",
    },
    {
      destination: "/bulk",
      permanent: true,
      source: "/features/bulk",
    },
    {
      destination: "/cancellations",
      permanent: true,
      source: "/features/cancellations",
    },
    {
      destination: "/escape-hatch",
      permanent: true,
      source: "/features/escape-hatch",
    },
    {
      destination: "/multipart",
      permanent: true,
      source: "/features/multipart",
    },
    {
      destination: "/prefixes",
      permanent: true,
      source: "/features/prefixes",
    },
    {
      destination: "/readonly",
      permanent: true,
      source: "/features/readonly",
    },
    {
      destination: "/resumable",
      permanent: true,
      source: "/features/resumable",
    },
    {
      destination: "/retries",
      permanent: true,
      source: "/features/retries",
    },
    {
      destination: "/timeouts",
      permanent: true,
      source: "/features/timeouts",
    },
  ],
  rewrites: () => [
    {
      destination: "/llms.mdx/:path*",
      source: "/:path*.md",
    },
  ],
};

export default withMDX(nextConfig);
