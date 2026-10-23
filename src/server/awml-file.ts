// What the registry reads from an AWML file itself: the AWML it says it is,
// and a workflow's implementations. The registry takes only AWML 0.4 and 0.5
// files; versions stored before stay readable as they were.
import { parse, parseDocument } from "yaml";

export const WORKFLOW_IS_TOO_OLD =
  "This registry takes AWML 0.4 and 0.5 files. Convert a 0.3 pair with `awml convert security.yaml platform.yaml > workflow.yaml` and push that.";

export const PLATFORM_IS_TOO_OLD =
  'This registry takes AWML 0.4 and 0.5 platform descriptions. Change `awml:` to "0.5" and push again.';

// The AWML versions the registry takes.
const TAKEN = ["0.4", "0.5"];

// The file as YAML, or null when it isn't YAML or isn't a map.
export function readYaml(text: string): Record<string, unknown> | null {
  try {
    const doc = parse(text) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Whether a file says it is some AWML other than 0.4 or 0.5. A file that
// says nothing, or isn't YAML, is left to `awml check`, whose messages say
// what is wrong with it; an unquoted 0.4 or 0.5 is too.
export function isOlderAwml(text: string) {
  const doc = readYaml(text);
  return doc !== null && doc.awml !== undefined && !TAKEN.includes(String(doc.awml));
}

// The AWML a file says it is, as its `awml:` field gives it, or null.
export function awmlOf(text: string | null | undefined) {
  const awml = text ? readYaml(text)?.awml : undefined;
  return awml === undefined || awml === null ? null : String(awml);
}

export type Implementation = { id: string; label: string };

// A workflow's implementations, in the order the file gives them, which
// is the order its platform views appear on a page. The file must pass check.
export function implementationsOf(text: string): Implementation[] {
  const found = readYaml(text)?.implementations;
  if (!found || typeof found !== "object") return [];
  return Object.entries(found as Record<string, { label?: unknown }>).map(([id, i]) => ({
    id,
    label: String(i?.label ?? id),
  }));
}

// Each block of an implementation that names a platform description, and
// the description's id: a bare id, or in a 0.5 file, owner/platforms/slug for
// a platform in the registry.
export function blockPlatforms(text: string, implementation: string): Map<string, string> {
  const implementations = readYaml(text)?.implementations as
    | Record<string, { blocks?: { id?: unknown; platform?: unknown }[] }>
    | undefined;
  const blocks = implementations?.[implementation]?.blocks ?? [];
  return new Map(blocks.flatMap((b) => (typeof b.platform === "string" ? [[String(b.id), b.platform] as const] : [])));
}

// How a 0.5 file names a platform in the registry, by its address.
export const REGISTERED_PLATFORM = /^([^/\s]+)\/platforms\/([^/\s]+)$/;

export const platformAddress = (owner: string, slug: string) => `${owner}/platforms/${slug}`;

// The id a platform description gives itself.
export const descriptionId = (text: string) => String((readYaml(text)?.platform as { id?: unknown } | undefined)?.id);

// A description given the id a block names it by, marked 0.5 so that the id
// may be owner/platforms/slug, for the engine to pair the two by id.
export function withDescriptionId(text: string, id: string) {
  const doc = parseDocument(text);
  doc.set("awml", "0.5");
  doc.setIn(["platform", "id"], id);
  return doc.toString();
}
