import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node:sqlite", "typescript"],
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/snapshots/*/overview": ["./README.md"],
    "/api/snapshots/*/questions": ["./README.md"],
  },
};

export default nextConfig;
