// Types for awml.js, the wrapper vendored from the AWML repo.
export interface AWML {
  check(source: string): string[];
  // The mistakes that stop a file being drawn: every one check gives, except a
  // line that breaks a rule, which draw draws red.
  unsound(source: string): string[];
  warnings(source: string): string[];
  // Every check, as awml check --json lists them, for files given as { file, source }.
  checksJSON(files: { file: string; source: string } | { file: string; source: string }[]): string;
  checks(files: { file: string; source: string } | { file: string; source: string }[]): unknown;
  summaryJSON(sources: string | string[]): string;
  summary(sources: string | string[]): unknown;
  // The workflow first, then platform descriptions. With an implementation,
  // the fit judges that implementation's placement, block by block.
  fitJSON(sources: string[], implementation?: string): string;
  fit(sources: string[], implementation?: string): unknown;
  // The design's security view, or with an implementation its platform view.
  draw(source: string, implementation?: string): string;
  // Where untrusted text reaches, as awml draw --untrusted draws it.
  drawUntrusted(source: string): string;
  // One file of an older version upgraded, or a 0.3 or 0.2 security view and
  // its platform view joined, into one file of the current version, as awml
  // convert does; a current file comes back unchanged. Throws what stops it;
  // when the current rules find mistakes in the result, the error's
  // `converted` holds it.
  convert(sources: string | string[], implementation?: string): string;
}

export function createAWML(source: WebAssembly.Module | BufferSource | Response): Promise<AWML>;
