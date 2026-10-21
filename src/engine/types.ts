// What the registry needs from the AWML package. The real implementation is
// the Go package compiled to WebAssembly; see ./index.ts for the swap point.

export type Files = { security?: string; platform?: string };

// Counts worked out from a version's files at push, such as how many steps AI
// decides. The inventory shows every key it finds and totals each one.
export type Summary = { counts: Record<string, number> };

export interface Engine {
  // The messages `awml check` gives for one file; empty when it has no mistakes.
  check(yaml: string): Promise<string[]>;
  summarise(files: Files): Promise<Summary>;
  // Mermaid text for one file, drawn in the browser.
  draw(yaml: string): Promise<string>;
}
