// The AWML Go package compiled to WebAssembly, so the registry gives the same
// verdict, summary and drawing as the awml command line. vendor/awml/VERSION
// names the AWML commit; `npm run engine:update` rebuilds it.
import { createAWML, type AWML } from "../../vendor/awml/awml.js";
import version from "../../vendor/awml/version.json";
import { loadAwmlModule } from "@/engine/module";
import type { Engine, Files, FitReport, ListedCheck, Summary } from "./types";

// One Go runtime per process or Worker isolate, started on first use.
let started: Promise<AWML> | undefined;

function awml() {
  started ??= loadAwmlModule().then(createAWML);
  return started;
}

export const wasmEngine: Engine = {
  version,
  async convert(sources) {
    const running = await awml();
    try {
      return { file: running.convert(sources), mistakes: [] };
    } catch (e) {
      const { message, converted } = e as Error & { converted?: string };
      return converted === undefined ? { error: message } : { file: converted, mistakes: message.split("\n") };
    }
  },
  async check(yaml) {
    return (await awml()).check(yaml);
  },
  async warnings(yaml) {
    return (await awml()).warnings(yaml);
  },
  async checks(yaml) {
    const listed = JSON.parse((await awml()).checksJSON([{ file: "workflow.yaml", source: yaml }])) as {
      checks: (Omit<ListedCheck, "skippedBecause" | "mistakes"> & {
        skipped_because?: string;
        mistakes: { message: string }[];
      })[];
    };
    return listed.checks.map((c) => ({
      id: c.id,
      name: c.name,
      about: c.about,
      result: c.result,
      ...(c.skipped_because === undefined ? {} : { skippedBecause: c.skipped_because }),
      mistakes: c.mistakes.map((m) => m.message),
    }));
  },
  async summarise(files: Files) {
    const sources = [files.workflow, files.security, files.platform].filter((f): f is string => f !== undefined);
    return (await awml()).summary(sources) as Summary;
  },
  async draw(yaml, implementation = "") {
    return (await awml()).draw(yaml, implementation);
  },
  async fit(workflow, descriptions, implementation = "") {
    return JSON.parse((await awml()).fitJSON([workflow, ...descriptions], implementation)) as FitReport;
  },
};
