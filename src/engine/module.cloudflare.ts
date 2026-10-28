// Cloudflare Workers: Wrangler bundles the .wasm file `npm run engine:build`
// built (`npm run cf:build` runs it first) as a compiled module, since
// workerd can neither read files nor compile fetched bytes.
import awml from "../../vendor/awml/awml.wasm?module";

export async function loadAwmlModule(): Promise<WebAssembly.Module> {
  return awml;
}
