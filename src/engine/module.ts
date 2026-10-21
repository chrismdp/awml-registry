// Node (tests, `next dev`, the Docker container): compile the vendored
// WebAssembly from disk. The Cloudflare build swaps this module for
// module.cloudflare.ts (see next.config.ts).
import fs from "node:fs/promises";
import path from "node:path";

export async function loadAwmlModule(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await fs.readFile(path.join(process.cwd(), "vendor", "awml", "awml.wasm")));
}
