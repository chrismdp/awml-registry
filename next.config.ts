import path from "node:path";
import type { NextConfig } from "next";

// `npm run cf:build` sets AWML_TARGET=cloudflare, which swaps two Node-only
// modules for Worker ones: the SQLite file driver for D1, so better-sqlite3
// never reaches the Worker bundle, and reading the AWML WebAssembly from disk
// for importing it as a compiled module.
const cloudflare = process.env.AWML_TARGET === "cloudflare";
const swaps = {
  "@/db/driver": cloudflare ? "./src/db/driver.cloudflare.ts" : "./src/db/driver.ts",
  "@/engine/module": cloudflare ? "./src/engine/module.cloudflare.ts" : "./src/engine/module.ts",
};

const nextConfig: NextConfig = {
  output: cloudflare ? undefined : "standalone",
  serverExternalPackages: ["better-sqlite3"],
  experimental: { authInterrupts: true },
  turbopack: { resolveAlias: swaps },
  webpack(config) {
    for (const [from, to] of Object.entries(swaps)) config.resolve.alias[from] = path.resolve(to);
    return config;
  },
};

export default nextConfig;
