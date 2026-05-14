import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/updates": ["../../packages/files-sdk/CHANGELOG.md"],
  },
};

export default nextConfig;
