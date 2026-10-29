// The AWML Go package compiled to WebAssembly, so the registry gives the same
// verdict, summary and drawing as the awml command line. vendor/awml/version.json
// pins the AWML release and commit, which `npm run engine:build` builds (it is
// never kept in git), and `npm run engine:update -- <tag>` moves.
import { createAWML, type AWML, type ConvertError } from "../../vendor/awml/awml.js";
import pin from "../../vendor/awml/version.json";
import { loadAwmlModule } from "@/engine/module";
import { memoise } from "./memo";
import type { Engine, Files, FitReport, ListedCheck, Named, PartsReport, Summary } from "./types";

// One Go runtime per process or Worker isolate, started on first use. A start
// that fails, such as before `npm run engine:build`, isn't kept, so the next
// use tries again, and a running dev server takes up an engine built later.
let started: Promise<AWML> | undefined;

function awml() {
  started ??= loadAwmlModule()
    .then(createAWML)
    .catch((e) => {
      started = undefined;
      throw e;
    });
  return started;
}

type Listed = {
  checks: (Omit<ListedCheck, "skippedBecause" | "mistakes"> & {
    skipped_because?: string;
    mistakes: { file?: string; message: string; severity?: "invalid" | "error" | "warning" }[];
  })[];
};

// Every check AWML runs on the files given together, with the mistakes,
// errors and warnings it finds in the first. A check that found some only in
// the others passes for the first.
async function listChecks(files: Named[]): Promise<ListedCheck[]> {
  return checksFor(JSON.parse((await awml()).checksJSON(files)) as Listed, files[0].file, true);
}

// The checks listed for files given together, as they fall to one of them: a
// mistake that names no file falls to the first. A check fails a file only
// for a mistake that makes that file invalid, and is an error where all it
// found in that file are errors, as AWML 0.9 says of each finding by its
// severity.
function checksFor(listed: Listed, file: string, first: boolean): ListedCheck[] {
  return listed.checks.map((c) => {
    const found = c.mistakes.filter((m) => (m.file === undefined ? first : m.file === file));
    let result = c.result;
    if (result === "fail" || result === "error" || result === "warn") {
      if (found.length === 0) result = "pass";
      else if (result !== "warn") result = found.some((m) => m.severity !== "error") ? "fail" : "error";
    }
    return {
      id: c.id,
      name: c.name,
      about: c.about,
      result,
      ...(c.skipped_because === undefined ? {} : { skippedBecause: c.skipped_because }),
      mistakes: found.map((m) => m.message),
    };
  });
}

// Each answer is worked out once for the same files (see ./memo.ts).
export const wasmEngine: Engine = {
  // The release and commit alone: the rest of the pin is how to build it.
  version: { tag: pin.tag, commit: pin.commit },
  async start() {
    await awml();
  },
  // convert throws what it notes and the mistakes it finds, as awml convert
  // exits 1 for them, but still gives the whole file, which is the answer.
  convert: memoise(async (sources: string[]) => {
    const running = await awml();
    try {
      return { file: running.convert(sources), notes: [], mistakes: [] };
    } catch (e) {
      const { message, converted, notes = [], mistakes = [] } = e as ConvertError;
      return converted === undefined ? { error: message } : { file: converted, notes, mistakes };
    }
  }),
  check: memoise(async (yaml: string) => (await awml()).check(yaml)),
  errors: memoise(async (yaml: string) => (await awml()).errors(yaml)),
  unsound: memoise(async (yaml: string) => (await awml()).unsound(yaml)),
  warnings: memoise(async (yaml: string) => (await awml()).warnings(yaml)),
  checks: memoise(async (yaml: string) => listChecks([{ file: "workflow.yaml", source: yaml }])),
  checksWith: memoise(async (file: Named, others: Named[]) => listChecks([file, ...others])),
  summarise: memoise(async (files: Files) => {
    const sources = [files.workflow, files.security, files.platform].filter((f): f is string => f !== undefined);
    return (await awml()).summary(sources) as Summary;
  }),
  graph: memoise(async (yaml: string, implementation = "") => (await awml()).graphJSON(yaml, implementation)),
  fit: memoise(
    async (workflow: string, descriptions: string[], implementation = "") =>
      JSON.parse((await awml()).fitJSON([workflow, ...descriptions], implementation)) as FitReport,
  ),
  fitParts: memoise(
    async (workflow: string, descriptions: string[]) =>
      JSON.parse((await awml()).fitPartsJSON([workflow, ...descriptions])) as PartsReport,
  ),
  checksAcross: memoise(async (files: Named[]) => {
    const listed = JSON.parse((await awml()).checksJSON(files)) as Listed;
    return files.map((f, i) => ({ file: f.file, checks: checksFor(listed, f.file, i === 0) }));
  }),
  summariseAcross: memoise(async (files: Named[]) => (await awml()).summary(files) as Summary),
  graphMap: memoise(async (files: Named[]) => (await awml()).graphJSON(files)),
  fitAcross: memoise(
    async (files: Named[], descriptions: string[]) =>
      JSON.parse((await awml()).fitJSON([...files, ...descriptions])) as FitReport,
  ),
};
