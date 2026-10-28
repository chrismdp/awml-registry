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

// Who may frame a page (#75). Another site may frame only an embed page,
// which sends `frame-ancestors *` and no X-Frame-Options; every other address
// sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so sign-in
// and settings can't be clickjacked. The embed pages' addresses are one
// pattern, and every other address is any path it doesn't match, so each
// address gets one set or the other. An owner's or a slug's name is spelled
// as names are, and never a name kept for other pages under it, so no other
// page's address is taken for an embed's: /api/auth/..., /platforms/... and
// /{owner}/platforms/... or /{owner}/systems/... are not. Next matches these
// on its own server, and OpenNext in the Worker, from the routes manifest.
const NAME = "[a-z0-9][a-z0-9-]*";
const OWNER = `(?!(?:api|platforms)/)${NAME}`;
const SLUG = `(?!(?:platforms|systems)/)${NAME}`;
const EMBEDS = `(?:${OWNER}/${SLUG}/embed|${OWNER}/${SLUG}/v/[0-9]+/embed|${OWNER}/systems/${NAME}/embed)`;

const nextConfig: NextConfig = {
  output: cloudflare ? undefined : "standalone",
  serverExternalPackages: ["better-sqlite3", "nodemailer"],
  // Next's own server matches the headers' paths with case only when told,
  // as OpenNext's Worker always does, so the two frame the same addresses.
  // An address no route answers gets its 404, with the site's header, from
  // src/app/global-not-found.tsx, since the root layout reads no session.
  experimental: { authInterrupts: true, caseSensitiveRoutes: true, globalNotFound: true },
  async headers() {
    return [
      {
        source: `/:path((?!${EMBEDS}/?$).*)`,
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      { source: `/:embed(${EMBEDS})`, headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
  turbopack: { resolveAlias: swaps },
  webpack(config) {
    for (const [from, to] of Object.entries(swaps)) config.resolve.alias[from] = path.resolve(to);
    return config;
  },
};

export default nextConfig;
