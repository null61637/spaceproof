import type { NextConfig } from "next";

import { backendUrl } from "./lib/config";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone, used by the production image.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // The repo root also has a package-lock.json (dev scripts); this app is self-contained.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Proxy /api/* to the NestJS backend so the browser sees a single origin (no CORS).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
