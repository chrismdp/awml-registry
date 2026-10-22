// What the registry needs from the AWML package, which runs here as the Go
// package compiled to WebAssembly (see ./wasm.ts).

export type Files = { security?: string; platform?: string };

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

export interface Engine {
  // The messages `awml check` gives for one file; empty when it has no mistakes.
  check(yaml: string): Promise<string[]>;
  // One workflow's summary from either view or both. The files must pass check.
  summarise(files: Files): Promise<Summary>;
  // Mermaid text for one file that passes check, drawn in the browser.
  draw(yaml: string): Promise<string>;
  // Where a workflow can run: its security view judged against platform
  // descriptions, each named by its own id. Every file must pass check.
  fit(security: string, descriptions: string[]): Promise<FitReport>;
}
