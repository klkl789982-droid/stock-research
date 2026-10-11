import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/model-performance/research": ["./data/history/*.json", "./data/model-history/*.json", "./data/market-prices/*.json", "./data/daily-runs/**/*.json", "./data/trading-calendar/status.json"],
    "/api/kis-eod-top-stocks": ["./data/kis-eod-published/*.json", "./data/history/*.json"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.runtime/kis-eod/**/*"],
  },
};

export default nextConfig;
