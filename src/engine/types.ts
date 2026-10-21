// What the registry needs from the AWML package, which runs here as the Go
// package compiled to WebAssembly (see ./wasm.ts).

export type Files = { security?: string; platform?: string };

// What `awml summary --json` gives for a workflow: the things an inventory counts.
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
  publishingLines: { count: number; labels: string[] };
  refusedReads: number;
  redLines: number;
};

export interface Engine {
  // The messages `awml check` gives for one file; empty when it has no mistakes.
  check(yaml: string): Promise<string[]>;
  // One workflow's summary from either view or both. The files must pass check.
  summarise(files: Files): Promise<Summary>;
  // Mermaid text for one file that passes check, drawn in the browser.
  draw(yaml: string): Promise<string>;
}
