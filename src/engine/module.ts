// Node (tests, `next dev`, the Docker container): compile the AWML
// WebAssembly from disk, as `npm run engine:build` built it from the commit
// vendor/awml/version.json pins (it is never kept in git). It is loaded only
// when the build's stamp names the pin and the file has the pinned SHA-256,
// so a stale or altered engine is never run. The Cloudflare build swaps this
// module for module.cloudflare.ts (see next.config.ts), whose build checks the
// same before it bundles the file.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ENGINE_MISSING = "The AWML engine isn't built: vendor/awml/awml.wasm is missing. Run: npm run engine:build";
export const ENGINE_STALE =
  "The AWML engine in vendor/awml isn't the one vendor/awml/version.json pins, so it isn't loaded. Run: npm run engine:build";

const vendored = (file: string) => path.join(process.cwd(), "vendor", "awml", file);

export async function loadAwmlModule(): Promise<WebAssembly.Module> {
  const bytes = await fs.readFile(vendored("awml.wasm")).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" ? new Error(ENGINE_MISSING) : e;
  });
  const json = async (file: string) => JSON.parse(await fs.readFile(vendored(file), "utf8").catch(() => "null"));
  const [pin, stamp] = await Promise.all([json("version.json"), json("build.json")]);
  const built =
    stamp?.tag === pin?.tag &&
    stamp?.commit === pin?.commit &&
    stamp?.go === pin?.go?.version &&
    createHash("sha256").update(bytes).digest("hex") === pin?.sha256?.["awml.wasm"];
  if (!built) throw new Error(ENGINE_STALE);
  return WebAssembly.compile(bytes);
}
