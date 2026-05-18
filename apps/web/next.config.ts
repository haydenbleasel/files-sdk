import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/updates": ["../../packages/files-sdk/CHANGELOG.md"],
  },
  redirects: () => [
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
  ],
};

export default withMDX(nextConfig);
