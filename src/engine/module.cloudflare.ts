// Cloudflare Workers: Wrangler bundles the .wasm file as a compiled module,
// since workerd can neither read files nor compile fetched bytes.
import awml from "../../vendor/awml/awml.wasm?module";

export async function loadAwmlModule(): Promise<WebAssembly.Module> {
  return awml;
}
