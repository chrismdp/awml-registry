// The AWML Go package compiled to WebAssembly, so the registry gives the same
// verdict, summary and drawing as the awml command line. vendor/awml/VERSION
// names the AWML commit; `npm run engine:update` rebuilds it.
import { createAWML, type AWML } from "../../vendor/awml/awml.js";
import { loadAwmlModule } from "@/engine/module";
import type { Engine, Files, Summary } from "./types";

// One Go runtime per process or Worker isolate, started on first use.
let started: Promise<AWML> | undefined;

function awml() {
  started ??= loadAwmlModule().then(createAWML);
  return started;
}

export const wasmEngine: Engine = {
  async check(yaml) {
    return (await awml()).check(yaml);
  },
  async summarise(files: Files) {
    const sources = [files.security, files.platform].filter((f): f is string => f !== undefined);
    return (await awml()).summary(sources) as Summary;
  },
  async draw(yaml) {
    return (await awml()).draw(yaml);
  },
};
