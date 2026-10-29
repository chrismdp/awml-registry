// Where a workflow can run: its design, or one implementation's placement,
// judged by the AWML engine against the platforms the caller may see, and
// never against any other.
import type { Db } from "@/db/client";
import { engine, type FitResult, type PartsReport } from "@/engine";
import { asRead, descriptionAsRead } from "./as-read";
import {
  blockPlatforms,
  descriptionId,
  implementationsOf,
  isOlderAwml,
  platformAddress,
  readYaml,
  REGISTERED_PLATFORM,
  withDescriptionId,
  WORKFLOW_IS_TOO_OLD,
} from "./awml-file";
import type { Owner } from "./owners";
import { findReadablePlatformVersion, notePrivatePlatformView, visiblePlatforms } from "./platforms";
import { readVersion } from "./registry";
import { refuse, type Result } from "./result";
import type { Viewer } from "./viewer";

export type FitBody = {
  workflow?: unknown;
  file?: unknown;
  security?: unknown;
  implementation?: unknown;
  platforms?: unknown;
  parts?: unknown;
};

// One platform's answer, under its registry address and version, with the id
// and label its description gives.
export type PlatformFit = Omit<FitResult, "platform"> & { platform: string; number: number; id: string; label: string };

// One block's answer when an implementation is judged: the block, and the
// platform its description came from, or nulls when it names none.
export type BlockFit = Omit<FitResult, "platform"> & {
  block: string;
  platform: string | null;
  number: number | null;
  id: string | null;
  label: string | null;
};

// Said beside each option of more than one platform. A platform description
// doesn't say what its parts can reach on another platform, so the engine
// judges each part on its own (awml#107).
export const NOT_JUDGED_ACROSS =
  "Judged part by part only: whether the parts on these platforms can reach each other isn't judged yet (chrismdp/awml#107).";

// Each part's fit, with `parts` (#100): the engine's answer, as
// `awml fit --parts --json` gives it, with each platform named as the fit's
// results name it, owner/slug, and the note beside each option of more than
// one platform.
export type PartsFit = Omit<PartsReport, "options"> & { options: (PartsReport["options"][number] & { note?: string })[] };

// How much `parts` judges together (#100). The engine tries every set of the
// platforms it is given, so each platform more doubles its work, and the
// options it lists, each placing every part, grow with the parts as well. An
// option holds every part with none to spare, so no option holds another,
// and of 8 platforms at most C(8, 4) = 70 sets do that, with at most 280
// platforms between them. So an answer places each part at most 70 times,
// under an id of at most 64 characters, and names a platform, owner/slug of
// at most 81, at most 280 times for each part: about 2.4 MB, worked out in
// 300 ms on Node. A design or a list of platforms beyond these is refused.
export const PARTS_LIMITS = { platforms: 8, parts: 80, id: 64 };

export type Fit = {
  workflow: { owner: string; slug: string; number: number } | null;
  implementation: string | null;
  results: PlatformFit[] | BlockFit[];
  gaps: string[];
  parts?: PartsFit;
};

const REF = /^([^/@\s]+)\/([^/@\s]+)(?:@([1-9]\d{0,8}))?$/;

// owner/slug or owner/slug@version.
function reference(text: string) {
  const match = REF.exec(text);
  return match ? { owner: match[1], slug: match[2], n: match[3] ?? ("latest" as const) } : null;
}

// The workflow the fit judges: a stored version's file, or the security view
// of one stored before 0.4, as the engine reads it, converted when it is in
// an older AWML; or a 0.9 file sent as YAML, as `file`, or as `security` as
// clients of the 0.3 API send it. With an implementation, it must be one the
// workflow has.
async function design(
  db: Db,
  viewer: Viewer,
  body: FitBody,
): Promise<Result<{ source: string; workflow: Fit["workflow"]; implementation: string | null }>> {
  const { workflow, implementation } = body;
  const yaml = body.file ?? body.security;
  if (implementation !== undefined && typeof implementation !== "string")
    return refuse(422, "implementation is the id of one of the workflow's implementations.");
  if (workflow !== undefined && yaml !== undefined)
    return refuse(422, "Send a workflow or the YAML of its file, not both.");
  const has = (source: string, named: string) => {
    if (implementation === undefined) return null;
    return implementationsOf(source).some((i) => i.id === implementation)
      ? null
      : refuse(422, `${named} has no implementation "${implementation}".`);
  };
  if (typeof workflow === "string") {
    const ref = reference(workflow);
    if (!ref) return refuse(422, "Name the workflow as owner/slug or owner/slug@version.");
    const v = await readVersion(db, viewer, ref.owner, ref.slug, ref.n);
    if (!v) return refuse(404, `Not found: ${workflow}.`);
    const named = `${v.owner}/${v.slug} v${v.number}`;
    const stored = v.files.workflow !== undefined ? "workflow" : v.files.security !== undefined ? "security" : null;
    if (stored === null) return refuse(422, `${named} has no security view, which the fit needs.`);
    // Only an invalid file isn't fitted: a drawing with errors is valid.
    const read = await asRead(v.files, stored);
    const mistakes = "error" in read ? read.error : await engine.unsound(read.file);
    if ("error" in read || mistakes.length) return refuse(422, ...mistakes.map((e) => `${named}: ${e}`));
    const source = read.file;
    const missing = has(source, named);
    if (missing) return missing;
    return {
      ok: true,
      source,
      workflow: { owner: v.owner, slug: v.slug, number: v.number },
      implementation: implementation ?? null,
    };
  }
  if (typeof yaml === "string") {
    if (isOlderAwml(yaml)) return refuse(400, WORKFLOW_IS_TOO_OLD);
    const found = await engine.unsound(yaml);
    if (found.length) return refuse(422, ...found.map((e) => `file: ${e}`));
    if (readYaml(yaml)?.parts === undefined)
      return refuse(422, "file: this is a platform description; the fit needs a workflow.");
    const missing = has(yaml, "This workflow");
    if (missing) return missing;
    return { ok: true, source: yaml, workflow: null, implementation: implementation ?? null };
  }
  if (workflow !== undefined) return refuse(422, "Name the workflow as owner/slug or owner/slug@version.");
  return refuse(422, "Send a workflow as owner/slug, or its AWML 0.9 file as file.");
}

type Candidate = {
  owner: { type: Owner["type"]; id: string; slug: string };
  slug: string;
  label: string;
  visibility: "public" | "private";
  number: number;
  description: string;
};

// The platforms to judge against: those named, each of which the viewer must
// be able to read, or else every platform the viewer may see. Each
// description is as the engine reads it, converted when it is stored in an
// older AWML.
async function candidates(db: Db, viewer: Viewer, named: unknown): Promise<Result<{ platforms: Candidate[] }>> {
  if (named === undefined) {
    const rows = await visiblePlatforms(db, viewer);
    return {
      ok: true,
      platforms: await Promise.all(
        rows.map(async (r) => ({
          ...r,
          owner: { type: r.ownerType, id: r.ownerId, slug: r.owner },
          description: await descriptionAsRead(r.description),
        })),
      ),
    };
  }
  if (!Array.isArray(named) || named.some((n) => typeof n !== "string"))
    return refuse(422, "platforms is a list of owner/slug or owner/slug@version.");
  const platforms: Candidate[] = [];
  for (const name of named as string[]) {
    const ref = reference(name);
    if (!ref) return refuse(422, "platforms is a list of owner/slug or owner/slug@version.");
    const found = await findReadablePlatformVersion(db, viewer, ref.owner, ref.slug, ref.n);
    if (!found) return refuse(404, `Not found: ${name}.`);
    const { owner, platform: p, version: v } = found;
    platforms.push({
      owner,
      slug: p.slug,
      label: v.label,
      visibility: p.visibility,
      number: v.number,
      description: await descriptionAsRead(v.description),
    });
  }
  return { ok: true, platforms };
}

// Fits a workflow, named as owner/slug[@version] or sent as its 0.9 file,
// against the platforms named, or every platform the viewer may see.
//
// The design is judged against each platform on its own, so one platform's
// description never touches another's answer. An implementation is judged
// block by block, each against the platform whose description its block
// names, found among those platforms: by its address when the block names
// owner/platforms/slug, and otherwise by the description's id. With `parts`,
// each part of the design is judged on its own against the same platforms
// as well (see partsOf). Each private platform judged is recorded as viewed
// in its organisation's audit log.
export async function fitWorkflow(db: Db, viewer: Viewer, body: FitBody): Promise<Result<{ fit: Fit }>> {
  if (body.parts !== undefined && typeof body.parts !== "boolean") return refuse(422, "parts is true or false.");
  if (body.parts && body.implementation !== undefined)
    return refuse(422, "parts judges the design, so it isn't given with implementation.");
  const judged = await design(db, viewer, body);
  if (!judged.ok) return judged;
  const { source, workflow, implementation } = judged;
  const designed = readYaml(source)?.parts;
  if (body.parts && Array.isArray(designed) && designed.length > PARTS_LIMITS.parts)
    return refuse(422, `parts judges a design of at most ${PARTS_LIMITS.parts} parts.`);
  if (body.parts && Array.isArray(designed) && (designed as { id?: unknown }[]).some((p) => String(p.id).length > PARTS_LIMITS.id))
    return refuse(422, `parts judges a design whose part ids are at most ${PARTS_LIMITS.id} characters.`);
  const found = await candidates(db, viewer, body.platforms);
  if (!found.ok) return found;
  if (body.parts && found.platforms.length > PARTS_LIMITS.platforms)
    return refuse(
      422,
      `parts judges at most ${PARTS_LIMITS.platforms} platforms together: name at most ${PARTS_LIMITS.platforms} in platforms.`,
    );
  const answer = (results: Fit["results"], gaps: string[] = [], parts?: PartsFit) => ({
    ok: true as const,
    fit: { workflow, implementation, results, gaps, ...(parts ? { parts } : {}) },
  });

  if (implementation !== null) {
    const named = blockPlatforms(source, implementation);
    const used = new Map<string, Candidate>();
    for (const id of new Set(named.values())) {
      const matching = found.platforms.filter((p) =>
        REGISTERED_PLATFORM.test(id) ? platformAddress(p.owner.slug, p.slug) === id : descriptionId(p.description) === id,
      );
      if (matching.length > 1)
        return refuse(
          422,
          `Name the platform for "${id}" in platforms: ${matching.map((p) => `${p.owner.slug}/${p.slug}`).join(" and ")} both describe it.`,
        );
      if (matching.length === 1) used.set(id, matching[0]);
    }
    // A platform named by its address is given to the engine under that id,
    // whatever id its stored description has, so the engine pairs them with
    // no network.
    const given = [...used].map(([id, p]) => (descriptionId(p.description) === id ? p.description : withDescriptionId(p.description, id)));
    const report = await engine.fit(source, given.length ? given : [NO_DESCRIPTION], implementation);
    if (report.gaps.length) return answer([], report.gaps);
    const results: BlockFit[] = report.results.map(({ platform: block, ...rest }) => {
      const p = named.has(block) ? used.get(named.get(block)!) : undefined;
      return p
        ? { block, platform: `${p.owner.slug}/${p.slug}`, number: p.number, id: named.get(block)!, label: p.label, ...rest }
        : { block, platform: null, number: null, id: null, label: null, ...rest };
    });
    for (const p of new Set(used.values())) await notePrivatePlatformView(db, viewer, p.owner, p, p.number);
    return answer(results);
  }

  const parts = body.parts ? await partsOf(source, found.platforms) : undefined;
  const results: PlatformFit[] = [];
  for (const p of found.platforms) {
    const report = await engine.fit(source, [p.description]);
    if (report.gaps.length) return answer([], report.gaps, parts);
    for (const { platform: id, ...rest } of report.results)
      results.push({ platform: `${p.owner.slug}/${p.slug}`, number: p.number, id, label: p.label, ...rest });
  }
  for (const p of found.platforms) await notePrivatePlatformView(db, viewer, p.owner, p, p.number);
  return answer(results, [], parts);
}

// Each part of the design judged on its own against the platforms, all
// given to the engine together, as `awml fit --parts` judges them, and every
// option of them that holds every part with none to spare. Each description
// is given under its registry address, owner/platforms/slug, as its id, so
// two platforms whose descriptions share an id are both judged, and each is
// named in the answer as the fit's results name it, owner/slug. Nothing else
// in the engine's answer changes, but that each option of more than one
// platform says that whether its parts can reach each other isn't judged.
// With no platform to judge against, nothing is judged. fitWorkflow keeps
// what it is given within PARTS_LIMITS.
async function partsOf(source: string, platforms: Candidate[]): Promise<PartsFit> {
  if (platforms.length === 0) return { parts: [], options: [], gaps: [] };
  const named = new Map(platforms.map((p) => [platformAddress(p.owner.slug, p.slug), `${p.owner.slug}/${p.slug}`]));
  const report = await engine.fitParts(
    source,
    platforms.map((p) => withDescriptionId(p.description, platformAddress(p.owner.slug, p.slug))),
  );
  const as = (id: string) => named.get(id) ?? id;
  return {
    parts: report.parts.map((p) => ({
      part: p.part,
      platforms: p.platforms.map(as),
      reasons: p.reasons.map((r) => ({ platform: as(r.platform), reasons: r.reasons })),
      models: Object.fromEntries(Object.entries(p.models).map(([id, companies]) => [as(id), companies])),
    })),
    options: report.options.map((o) => ({
      platforms: o.platforms.map(as),
      placement: o.placement.map((p) => ({ part: p.part, platforms: p.platforms.map(as) })),
      ...(o.platforms.length > 1 ? { note: NOT_JUDGED_ACROSS } : {}),
    })),
    gaps: report.gaps,
  };
}

// AWML's engine takes at least one description, even for an implementation
// whose blocks name none the caller may see. This one stands in: no block
// names it, so it judges nothing, and the engine still reports each block
// that names no platform, and each whose description wasn't given.
const NO_DESCRIPTION = `awml: "0.9"
platform: { id: registry-gave-no-description, label: "No description" }
off_for_up_to: PT0S
steps: code
agents: []
calls: []
holds: []
`;
