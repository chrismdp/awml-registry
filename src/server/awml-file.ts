// What the registry reads from an AWML file itself: the AWML it says it is,
// and a 0.4 workflow's implementations. The registry takes only AWML 0.4
// files; versions stored before stay readable as they were.
import { parse } from "yaml";

export const WORKFLOW_IS_NOT_04 =
  "This registry takes AWML 0.4 files. Convert a 0.3 pair with `awml convert security.yaml platform.yaml > workflow.yaml` and push that.";

export const PLATFORM_IS_NOT_04 =
  'This registry takes AWML 0.4 platform descriptions. Change `awml:` to "0.4" and push again.';

// The file as YAML, or null when it isn't YAML or isn't a map.
export function readYaml(text: string): Record<string, unknown> | null {
  try {
    const doc = parse(text) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Whether a file says it is some AWML other than 0.4. A file that says
// nothing, or isn't YAML, is left to `awml check`, whose messages say what is
// wrong with it; an unquoted 0.4 is too.
export function isOlderAwml(text: string) {
  const doc = readYaml(text);
  return doc !== null && doc.awml !== undefined && String(doc.awml) !== "0.4";
}

// The AWML a file says it is, as its `awml:` field gives it, or null.
export function awmlOf(text: string | null | undefined) {
  const awml = text ? readYaml(text)?.awml : undefined;
  return awml === undefined || awml === null ? null : String(awml);
}

export type Implementation = { id: string; label: string };

// A 0.4 workflow's implementations, in the order the file gives them, which
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
// the description's id.
export function blockPlatforms(text: string, implementation: string): Map<string, string> {
  const implementations = readYaml(text)?.implementations as
    | Record<string, { blocks?: { id?: unknown; platform?: unknown }[] }>
    | undefined;
  const blocks = implementations?.[implementation]?.blocks ?? [];
  return new Map(blocks.flatMap((b) => (typeof b.platform === "string" ? [[String(b.id), b.platform] as const] : [])));
}
