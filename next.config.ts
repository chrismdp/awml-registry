import path from "node:path";
import type { NextConfig } from "next";

// `npm run cf:build` sets AWML_TARGET=cloudflare, which swaps four Node-only
// modules for Worker ones: the SQLite file driver for D1, so better-sqlite3
// never reaches the Worker bundle; reading the AWML WebAssembly from disk for
// importing it as a compiled module; SMTP through nodemailer for
// Cloudflare's EMAIL binding; and fetching an AI client's metadata document
// through a pinned Node connection for a Worker's fetch after a DNS check.
const cloudflare = process.env.AWML_TARGET === "cloudflare";
const swaps = {
  "@/db/driver": cloudflare ? "./src/db/driver.cloudflare.ts" : "./src/db/driver.ts",
  "@/engine/module": cloudflare ? "./src/engine/module.cloudflare.ts" : "./src/engine/module.ts",
  "@/server/mail-platform": cloudflare ? "./src/server/mail-platform.cloudflare.ts" : "./src/server/mail-platform.ts",
  "@/server/metadata-transport": cloudflare
    ? "./src/server/metadata-transport.cloudflare.ts"
    : "./src/server/metadata-transport.ts",
};

const nextConfig: NextConfig = {
  output: cloudflare ? undefined : "standalone",
  serverExternalPackages: ["better-sqlite3", "nodemailer"],
  experimental: { authInterrupts: true },
  turbopack: { resolveAlias: swaps },
  webpack(config) {
    for (const [from, to] of Object.entries(swaps)) config.resolve.alias[from] = path.resolve(to);
    return config;
  },
};

export default nextConfig;
