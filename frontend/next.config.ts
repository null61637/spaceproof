import type { NextConfig } from "next";

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
  // /api/* reaches the NestJS backend through app/api/[...path]/route.ts, not
  // through `rewrites()`: the rewrite proxy buffers request bodies in memory
  // and truncates them at 10 MB.
};

export default nextConfig;
