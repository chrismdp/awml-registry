// The AWML Go package compiled to WebAssembly, so the registry gives the same
// verdict, summary and drawing as the awml command line. vendor/awml/VERSION
// names the AWML commit; `npm run engine:update` rebuilds it.
import { createAWML, type AWML } from "../../vendor/awml/awml.js";
import version from "../../vendor/awml/version.json";
import { loadAwmlModule } from "@/engine/module";
import type { Engine, Files, FitReport, ListedCheck, Named, Summary } from "./types";

// One Go runtime per process or Worker isolate, started on first use.
let started: Promise<AWML> | undefined;

function awml() {
  started ??= loadAwmlModule().then(createAWML);
  return started;
}

// Every check AWML runs on the files given together, with the mistakes and
// warnings it finds in the first. A check that found some only in the others
// passes for the first.
async function listChecks(files: Named[]): Promise<ListedCheck[]> {
  const listed = JSON.parse((await awml()).checksJSON(files)) as {
    checks: (Omit<ListedCheck, "skippedBecause" | "mistakes"> & {
      skipped_because?: string;
      mistakes: { file?: string; message: string }[];
    })[];
  };
  return listed.checks.map((c) => {
    const mistakes = c.mistakes.filter((m) => m.file === undefined || m.file === files[0].file).map((m) => m.message);
    const result = (c.result === "fail" || c.result === "warn") && mistakes.length === 0 ? "pass" : c.result;
    return {
      id: c.id,
      name: c.name,
      about: c.about,
      result,
      ...(c.skipped_because === undefined ? {} : { skippedBecause: c.skipped_because }),
      mistakes,
    };
  });
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
    return listChecks([{ file: "workflow.yaml", source: yaml }]);
  },
  async checksWith(file, others) {
    return listChecks([file, ...others]);
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
