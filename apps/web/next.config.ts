import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/updates": ["../../packages/files-sdk/CHANGELOG.md"],
  },
};

export default withMDX(nextConfig);
