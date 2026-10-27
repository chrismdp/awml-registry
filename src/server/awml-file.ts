// What the registry reads from an AWML file itself: the AWML it says it is,
// and a workflow's implementations. The registry takes only AWML 0.7 files;
// versions stored before stay as they were, and are converted when read
// (see ./as-read.ts).
import { parse, parseDocument } from "yaml";

export const WORKFLOW_IS_TOO_OLD =
  "This registry takes AWML 0.7 files. Upgrade yours with `awml convert workflow.yaml > upgraded.yaml`, " +
  "or join a 0.3 pair with `awml convert security.yaml platform.yaml > upgraded.yaml`, and push that.";

export const PLATFORM_IS_TOO_OLD =
  "This registry takes AWML 0.7 platform descriptions. Upgrade yours with `awml convert description.yaml > upgraded.yaml` and push that.";

// The AWML the registry takes, the one its engine reads.
export const CURRENT_AWML = "0.7";

// The file as YAML, or null when it isn't YAML or isn't a map.
export function readYaml(text: string): Record<string, unknown> | null {
  try {
    const doc = parse(text) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Whether a file says it is some AWML other than 0.7. A file that says
// nothing, or isn't YAML, is left to `awml check`, whose messages say what is
// wrong with it; an unquoted 0.7 is too.
export function isOlderAwml(text: string) {
  const doc = readYaml(text);
  return doc !== null && doc.awml !== undefined && String(doc.awml) !== CURRENT_AWML;
}

// The AWML a file says it is, as its `awml:` field gives it, or null.
export function awmlOf(text: string | null | undefined) {
  const awml = text ? readYaml(text)?.awml : undefined;
  return awml === undefined || awml === null ? null : String(awml);
}

// The kind of each part a workflow's file holds, by its id.
export function partKinds(text: string): Record<string, string> {
  const parts = readYaml(text)?.parts;
  if (!Array.isArray(parts)) return {};
  return Object.fromEntries(
    parts.flatMap((p: { id?: unknown; kind?: unknown } | null) =>
      p && typeof p.id === "string" && typeof p.kind === "string" ? [[p.id, p.kind]] : [],
    ),
  );
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
// the description's id: a bare id, or owner/platforms/slug for a platform in
// the registry.
export function blockPlatforms(text: string, implementation: string): Map<string, string> {
  const implementations = readYaml(text)?.implementations as
    | Record<string, { blocks?: { id?: unknown; platform?: unknown }[] }>
    | undefined;
  const blocks = implementations?.[implementation]?.blocks ?? [];
  return new Map(blocks.flatMap((b) => (typeof b.platform === "string" ? [[String(b.id), b.platform] as const] : [])));
}

// How a file names a platform in the registry, by its address, as AWML 0.5
// first allowed.
export const REGISTERED_PLATFORM = /^([^/\s]+)\/platforms\/([^/\s]+)$/;

export const platformAddress = (owner: string, slug: string) => `${owner}/platforms/${slug}`;

// The id a platform description gives itself.
export const descriptionId = (text: string) => String((readYaml(text)?.platform as { id?: unknown } | undefined)?.id);

// A description given the id a block names it by, which may be
// owner/platforms/slug, for the engine to pair the two by id. The description
// must be one the engine reads.
export function withDescriptionId(text: string, id: string) {
  const doc = parseDocument(text);
  doc.setIn(["platform", "id"], id);
  return doc.toString();
}
