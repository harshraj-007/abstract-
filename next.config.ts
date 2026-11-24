import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node:sqlite", "typescript"],
  poweredByHeader: false,
};

export default nextConfig;
