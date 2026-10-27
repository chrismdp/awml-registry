// What the registry needs from the AWML package, which runs here as the Go
// package compiled to WebAssembly (see ./wasm.ts).

// A version's files: one AWML workflow, or, for versions stored before the
// registry took only 0.4 files, a security view, a platform view or both.
export type Files = { workflow?: string; security?: string; platform?: string };

// A file given to the engine with its path, which names it in the mistakes.
export type Named = { file: string; source: string };

// What `awml summary --json` gives for a workflow: the things an inventory
// counts, and the names of its AI steps, people, scopes and platforms. The Go
// package writes an empty list as null. Summaries saved before AWML named
// things have no lists at all; src/server/summary.ts reads both the same.
export type Summary = {
  steps: { ai: number; code: number; person: number };
  operations: Record<string, number>;
  outsideActions: { allow: number; ask: number; block: number };
  triggers: number;
  reviews: number;
  contexts: number;
  connectors: number;
  surfaces: number;
  scopes: number;
  platforms: number;
  publishingLines: { count: number; labels: string[] | null };
  refusedReads: number;
  redLines: number;
  aiSteps?: string[] | null;
  people?: { label: string; kind: "person" | "review" }[] | null;
  scopeNames?: string[] | null;
  platformNames?: string[] | null;
  // Given several workflows, each part more than one of them holds, by the
  // ref between them, with the titles of the workflows that hold it.
  shared?: { label: string; kind: string; workflows: string[] }[] | null;
};

// What `awml fit --json` gives: for each platform, whether the workflow fits
// it, every reason it doesn't, and the companies each AI step may use there.
// The gaps are what the workflow doesn't say that the fit needs; when there
// are any, there are no results.
export type FitResult = {
  platform: string;
  judged: boolean;
  fits: boolean;
  reasons: string[];
  models: Record<string, string[]>;
};
export type FitReport = { results: FitResult[]; gaps: string[] };

// One check `awml check --json` lists for a file, in the order AWML's spec
// gives them: its stable id, its name, what it guards, and its result. A
// failed check gives its mistakes, a warning its warnings, and a skipped
// check why it did not apply.
export type ListedCheck = {
  id: string;
  name: string;
  about: string;
  result: "pass" | "fail" | "skipped" | "warn";
  skippedBecause?: string;
  mistakes: string[];
};

// A file converted to the AWML the engine reads, and the mistakes its rules
// find in the result; or why it could not be converted at all.
export type Converted = { file: string; mistakes: string[] } | { error: string };

export interface Engine {
  // The AWML it was built from: its release, as `git describe --tags` names
  // it, and its commit (vendor/awml/VERSION).
  version: { tag: string; commit: string };
  // Starts the engine, if it hasn't started, and says when it has; a page
  // starts it without waiting, so its first start overlaps reading the database.
  start(): Promise<void>;
  // One file of an older AWML upgraded, or a 0.3 or 0.2 security view and its
  // platform view joined, as `awml convert` does. A file of the AWML the
  // engine reads comes back unchanged.
  convert(sources: string[]): Promise<Converted>;
  // The messages `awml check` gives for one file; empty when it has no mistakes.
  check(yaml: string): Promise<string[]>;
  // The warnings `awml check` gives for one file, such as a do step AI
  // decides. A warning is not a mistake and fails nothing.
  warnings(yaml: string): Promise<string[]>;
  // Every check AWML runs on one file, with the result of each.
  checks(yaml: string): Promise<ListedCheck[]>;
  // Every check AWML runs on one workflow given with the workflows its refs
  // name, each at a path ending owner/slug.yaml, so the engine follows an
  // owner/slug#id ref to the file at that path. Only the first file's
  // mistakes and warnings are given; a check that failed only in another
  // file passes.
  checksWith(file: Named, others: Named[]): Promise<ListedCheck[]>;
  // One workflow's summary from its files. The files must pass check.
  summarise(files: Files): Promise<Summary>;
  // Mermaid text for one file that passes check, drawn in the browser: its
  // security view, or a workflow's platform view of one implementation.
  draw(yaml: string, implementation?: string): Promise<string>;
  // Where a workflow can run: its design judged against platform
  // descriptions, each named by its own id. With an implementation, its
  // placement is judged instead, each block against the description it
  // names. Every file must pass check.
  fit(workflow: string, descriptions: string[], implementation?: string): Promise<FitReport>;

  // Several workflows given together, as a system gives them, each at a path
  // ending owner/slug.yaml so the refs between them are followed. Every file
  // must pass check, except for checksAcross; the others throw the mistakes
  // following the refs finds.
  //
  // Every check AWML runs on the files together, listed for each file with
  // the mistakes and warnings found in it.
  checksAcross(files: Named[]): Promise<{ file: string; checks: ListedCheck[] }[]>;
  // What the workflows' summary counts and names across them all, with the
  // parts they share.
  summariseAcross(files: Named[]): Promise<Summary>;
  // The map: one box per workflow, the parts they share drawn once. A single
  // workflow draws its security view.
  drawMap(files: Named[]): Promise<string>;
  // Each platform described judged running every workflow given.
  fitAcross(files: Named[], descriptions: string[]): Promise<FitReport>;
}
