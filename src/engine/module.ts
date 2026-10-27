// Node (tests, `next dev`, the Docker container): compile the AWML
// WebAssembly from disk, as `npm run engine:build` built it from the commit
// vendor/awml/version.json pins (it is never kept in git). The Cloudflare
// build swaps this module for module.cloudflare.ts (see next.config.ts).
import fs from "node:fs/promises";
import path from "node:path";

export const ENGINE_MISSING = "The AWML engine isn't built: vendor/awml/awml.wasm is missing. Run: npm run engine:build";

export async function loadAwmlModule(): Promise<WebAssembly.Module> {
  const file = path.join(process.cwd(), "vendor", "awml", "awml.wasm");
  const bytes = await fs.readFile(file).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" ? new Error(ENGINE_MISSING) : e;
  });
  return WebAssembly.compile(bytes);
}
