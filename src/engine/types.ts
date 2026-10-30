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
  // The Go package writes none as null, as AWML 0.7 does for a workflow whose
  // steps name no operation.
  operations: Record<string, number> | null;
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
  // Each part marked untrusted, by its label, with the steps and outside
  // actions its text reaches, the parts that stop it and, from AWML 0.8, each
  // outside action whose risk a standing approval in front of it accepts.
  // Given several workflows, the text follows an outside action into the
  // workflow it starts (AWML 0.7). Summaries saved before AWML 0.7 have none.
  untrusted?:
    | {
        part: string;
        steps: string[] | null;
        outsideActions: string[] | null;
        stoppedBy: string[] | null;
        risksAccepted?: { outsideAction: string; approval: string }[] | null;
      }[]
    | null;
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

// What `awml fit --parts --json` gives (AWML 0.9, registry issue #100): each
// trigger, step that runs on a platform, context and connector judged alone,
// with the platforms that can hold it, every reason each other can't, and the
// companies an AI step may use on each that holds it; then each option, a set
// of platforms that between them hold every part with none to spare, smallest
// first, with where each part may go in it, every platform in the option that
// can hold it, the engine not choosing. Whether the parts of an option on
// several platforms can reach each other isn't judged (awml#107). The gaps
// are what the workflow doesn't say that the fit needs; when there are any,
// there are no parts and no options.
export type PartsReport = {
  parts: { part: string; platforms: string[]; reasons: { platform: string; reasons: string[] }[]; models: Record<string, string[]> }[];
  options: { platforms: string[]; placement: { part: string; platforms: string[] }[] }[];
  gaps: string[];
};

// One check `awml check --json` lists for a file, in the order AWML's spec
// gives them: its stable id, its name, what it guards, and its result. A
// failed check gives the mistakes that make the file invalid, an error check
// its errors, the lines that break a rule in a valid drawing (from AWML 0.9),
// a warning its warnings, and a skipped check why it did not apply.
export type ListedCheck = {
  id: string;
  name: string;
  about: string;
  result: "pass" | "fail" | "error" | "skipped" | "warn";
  skippedBecause?: string;
  mistakes: string[];
};

// A file converted to the AWML the engine reads, what converting it noted
// for its author to do by hand, and the mistakes its rules find that make the
// result invalid, leaving its errors to check; or why it could not be
// converted at all.
export type Converted = { file: string; notes: string[]; mistakes: string[] } | { error: string };

export interface Engine {
  // The AWML it was built from: its release and its commit, as
  // vendor/awml/version.json pins them.
  version: { tag: string; commit: string };
  // Starts the engine, if it hasn't started, and says when it has; a page
  // starts it without waiting, so its first start overlaps reading the database.
  start(): Promise<void>;
  // One file of an older AWML upgraded, or a 0.3 or 0.2 security view and its
  // platform view joined, as `awml convert` does. A file of the AWML the
  // engine reads comes back unchanged. From AWML 0.9 a workflow with no
  // description takes the comment block its file starts with as one.
  convert(sources: string[]): Promise<Converted>;
  // The messages `awml check` gives for one file, warnings aside: its errors,
  // then the mistakes that make it invalid; empty when it has neither.
  check(yaml: string): Promise<string[]>;
  // A file's errors (AWML 0.9, #100): the lines that break a rule, such as
  // untrusted text reaching an outside action that nothing stops, which the
  // drawing draws red with the words of the rule each breaks. A drawing with
  // errors is valid: it is stored, drawn, summarised and fitted.
  errors(yaml: string): Promise<string[]>;
  // The mistakes that make one file invalid, so that it can't be read or
  // drawn, as `awml draw` refuses it: every one check gives but an error. The
  // registry never stores an invalid file.
  unsound(yaml: string): Promise<string[]>;
  // The warnings `awml check` gives for one file, such as a do step AI
  // decides. A warning is not a mistake and fails nothing.
  warnings(yaml: string): Promise<string[]>;
  // Every check AWML runs on one file, with the result of each.
  checks(yaml: string): Promise<ListedCheck[]>;
  // Every check AWML runs on one workflow given with the workflows its refs
  // name, each at a path ending owner/slug.yaml, so the engine follows an
  // owner/slug#id ref to the file at that path. Only the first file's
  // mistakes, errors and warnings are given; a check that found some only in
  // another file passes.
  checksWith(file: Named, others: Named[]): Promise<ListedCheck[]>;
  // One workflow's summary from its files. The files must be valid.
  summarise(files: Files): Promise<Summary>;
  // What one file draws, as AWML's graph JSON, which the registry lays its
  // drawing out from (src/server/drawing.ts): its security view, or a
  // workflow's platform view of one implementation. The file must be valid,
  // and its errors are drawn red. Its text is unescaped
  // (src/components/flow/graph.ts).
  graph(yaml: string, implementation?: string): Promise<string>;
  // Where a workflow can run: its design judged against platform
  // descriptions, each named by its own id. With an implementation, its
  // placement is judged instead, each block against the description it
  // names. Every file must be valid.
  fit(workflow: string, descriptions: string[], implementation?: string): Promise<FitReport>;
  // Each part of a workflow's design judged alone against platform
  // descriptions, each named by its own id, and every option of them that
  // holds every part, as `awml fit --parts` does. At least one description
  // must be given, and every file must be valid.
  fitParts(workflow: string, descriptions: string[]): Promise<PartsReport>;

  // Several workflows given together, as a system gives them, each at a path
  // ending owner/slug.yaml so the refs between them are followed. Every file
  // must be valid, except for checksAcross; the others throw the mistakes
  // following the refs finds that make a file invalid.
  //
  // Every check AWML runs on the files together, listed for each file with
  // the mistakes, errors and warnings found in it.
  checksAcross(files: Named[]): Promise<{ file: string; checks: ListedCheck[] }[]>;
  // What the workflows' summary counts and names across them all, with the
  // parts they share.
  summariseAcross(files: Named[]): Promise<Summary>;
  // The map's graph JSON: one box per workflow, each trigger outside its box,
  // the parts they share drawn once, and a line from each outside action that
  // starts a workflow to its trigger. A single workflow gives its security view.
  graphMap(files: Named[]): Promise<string>;
  // Each platform described judged running every workflow given.
  fitAcross(files: Named[], descriptions: string[]): Promise<FitReport>;
}
