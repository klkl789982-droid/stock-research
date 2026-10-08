import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/kis-eod-top-stocks": ["./data/kis-eod-published/*.json", "./data/history/*.json"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.runtime/kis-eod/**/*"],
  },
};

export default nextConfig;
