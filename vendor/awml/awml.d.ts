// Types for awml.js, the wrapper vendored from the AWML repo.
export interface AWML {
  check(source: string): string[];
  summaryJSON(sources: string | string[]): string;
  summary(sources: string | string[]): unknown;
  draw(source: string): string;
}

export function createAWML(source: WebAssembly.Module | BufferSource | Response): Promise<AWML>;
