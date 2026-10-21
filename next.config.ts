import path from "node:path";
import type { NextConfig } from "next";

// `npm run cf:build` sets AWML_TARGET=cloudflare, which swaps the SQLite file
// driver for the D1 one so better-sqlite3 never reaches the Worker bundle.
const cloudflare = process.env.AWML_TARGET === "cloudflare";
const driver = cloudflare ? "./src/db/driver.cloudflare.ts" : "./src/db/driver.ts";

const nextConfig: NextConfig = {
  output: cloudflare ? undefined : "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: { authInterrupts: true },
  turbopack: { resolveAlias: { "@/db/driver": driver } },
  webpack(config) {
    config.resolve.alias["@/db/driver"] = path.resolve(driver);
    return config;
  },
};

export default nextConfig;
