// Types for awml.js, the wrapper vendored from the AWML repo.

// A file given with its path, which names it in the mistakes and, given with
// others, lets a ref find it: owner/slug#id at a path ending owner/slug.yaml.
export type NamedSource = { file: string; source: string };

// One file's text, a file with its path, or several given together.
export type Sources = string | NamedSource | (string | NamedSource)[];

export interface AWML {
  // What awml check reports of a file, warnings aside: its errors, then the
  // mistakes that make it invalid.
  check(source: string): string[];
  // A file's errors: the lines that break a rule, which draw draws red. A
  // drawing with errors is valid.
  errors(source: string): string[];
  // The mistakes that make a file invalid, so that it can't be read or drawn:
  // every one check gives, except an error.
  unsound(source: string): string[];
  warnings(source: string): string[];
  // Every check, as awml check --json lists them, for files given as { file, source }.
  // Given together, workflows follow each ref between them.
  checksJSON(files: NamedSource | NamedSource[]): string;
  checks(files: NamedSource | NamedSource[]): unknown;
  // What a workflow's summary counts and names; given several, across them all.
  summaryJSON(sources: Sources): string;
  summary(sources: Sources): unknown;
  // Workflows first, then platform descriptions: each platform judged running
  // every workflow given. With an implementation, the fit judges that
  // implementation's placement, block by block.
  fitJSON(sources: Sources, implementation?: string): string;
  fit(sources: Sources, implementation?: string): unknown;
  // Workflows first, then platform descriptions, as awml fit --parts --json:
  // each part judged alone against each platform, and each option of
  // platforms that between them hold every part with none to spare.
  fitPartsJSON(sources: Sources): string;
  fitParts(sources: Sources): unknown;
  // The design's security view, or with an implementation its platform view.
  // Given several workflows, the map: one box per workflow, the parts they
  // share drawn once. The platform descriptions given, each paired with the
  // block that names its id, show which of a platform view's code steps a
  // model carries out (AWML 0.10.1).
  draw(source: Sources, implementation?: string, descriptions?: Sources): string;
  // What draw draws, with nothing laid out, as awml graph does: one
  // workflow's view, or the map of several given together, as JSON. It takes
  // and throws what draw does. No text in it is escaped: every label is as
  // the file wrote it, line breaks included, so a page must escape it.
  graphJSON(source: Sources, implementation?: string, descriptions?: Sources): string;
  graph(source: Sources, implementation?: string, descriptions?: Sources): unknown;
  // One file of an older version upgraded, or a 0.3 or 0.2 security view and
  // its platform view joined, into one file of the current version, as awml
  // convert does; a current file comes back unchanged. Throws what stops it.
  // When it notes something it couldn't carry over, or the current rules find
  // the result invalid, it throws them too, and the error's `notes` and
  // `mistakes` hold each and its `converted` the whole file, which awml
  // convert still writes. A result with errors is valid, so they are left to
  // check. A workflow with no description takes the comment block its file
  // starts with as its description.
  convert(sources: string | string[], implementation?: string): string;
}

// What convert throws when it converted the file but has notes, or mistakes
// that make it invalid.
export type ConvertError = Error & { notes?: string[]; mistakes?: string[]; converted?: string };

export function createAWML(source: WebAssembly.Module | BufferSource | Response): Promise<AWML>;
