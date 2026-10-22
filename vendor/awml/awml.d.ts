// Types for awml.js, the wrapper vendored from the AWML repo.
export interface AWML {
  check(source: string): string[];
  warnings(source: string): string[];
  summaryJSON(sources: string | string[]): string;
  summary(sources: string | string[]): unknown;
  // The workflow first, then platform descriptions. With an implementation,
  // the fit judges that implementation's placement, block by block.
  fitJSON(sources: string[], implementation?: string): string;
  fit(sources: string[], implementation?: string): unknown;
  // The design's security view, or with an implementation its platform view.
  draw(source: string, implementation?: string): string;
}

export function createAWML(source: WebAssembly.Module | BufferSource | Response): Promise<AWML>;
