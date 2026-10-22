// Where a workflow can run: its design, or one implementation's placement,
// judged by the AWML engine against the platforms the caller may see, and
// never against any other.
import type { Db } from "@/db/client";
import { engine, type FitResult } from "@/engine";
import { blockPlatforms, implementationsOf, isOlderAwml, readYaml, WORKFLOW_IS_NOT_04 } from "./awml-file";
import type { Owner } from "./owners";
import { findReadablePlatformVersion, notePrivatePlatformView, visiblePlatforms } from "./platforms";
import { readVersion } from "./registry";
import { refuse, type Result } from "./result";
import type { Viewer } from "./viewer";

export type FitBody = { workflow?: unknown; file?: unknown; security?: unknown; implementation?: unknown; platforms?: unknown };

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

export type Fit = {
  workflow: { owner: string; slug: string; number: number } | null;
  implementation: string | null;
  results: PlatformFit[] | BlockFit[];
  gaps: string[];
};

const REF = /^([^/@\s]+)\/([^/@\s]+)(?:@([1-9]\d{0,8}))?$/;

// owner/slug or owner/slug@version.
function reference(text: string) {
  const match = REF.exec(text);
  return match ? { owner: match[1], slug: match[2], n: match[3] ?? ("latest" as const) } : null;
}

// The workflow the fit judges: a stored version's 0.4 file, or the security
// view of one stored before; or a 0.4 file sent as YAML, as `file`, or as
// `security` as clients of the 0.3 API send it. With an implementation, it
// must be one the workflow has.
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
    const source = v.files.workflow ?? v.files.security;
    if (source === undefined) return refuse(422, `${named} has no security view, which the fit needs.`);
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
    if (isOlderAwml(yaml)) return refuse(400, WORKFLOW_IS_NOT_04);
    const found = await engine.check(yaml);
    if (found.length) return refuse(422, ...found.map((e) => `file: ${e}`));
    if (readYaml(yaml)?.parts === undefined)
      return refuse(422, "file: this is a platform description; the fit needs a workflow.");
    const missing = has(yaml, "This workflow");
    if (missing) return missing;
    return { ok: true, source: yaml, workflow: null, implementation: implementation ?? null };
  }
  if (workflow !== undefined) return refuse(422, "Name the workflow as owner/slug or owner/slug@version.");
  return refuse(422, "Send a workflow as owner/slug, or its AWML 0.4 file as file.");
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
// be able to read, or else every platform the viewer may see.
async function candidates(db: Db, viewer: Viewer, named: unknown): Promise<Result<{ platforms: Candidate[] }>> {
  if (named === undefined) {
    const rows = await visiblePlatforms(db, viewer);
    return {
      ok: true,
      platforms: rows.map((r) => ({ ...r, owner: { type: r.ownerType, id: r.ownerId, slug: r.owner } })),
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
    platforms.push({ owner, slug: p.slug, label: v.label, visibility: p.visibility, number: v.number, description: v.description });
  }
  return { ok: true, platforms };
}

// Fits a workflow, named as owner/slug[@version] or sent as its 0.4 file,
// against the platforms named, or every platform the viewer may see.
//
// The design is judged against each platform on its own, so one platform's
// description never touches another's answer. An implementation is judged
// block by block, each against the platform whose description its block
// names, found among those platforms by the description's id. Each private
// platform judged is recorded as viewed in its organisation's audit log.
export async function fitWorkflow(db: Db, viewer: Viewer, body: FitBody): Promise<Result<{ fit: Fit }>> {
  const judged = await design(db, viewer, body);
  if (!judged.ok) return judged;
  const { source, workflow, implementation } = judged;
  const found = await candidates(db, viewer, body.platforms);
  if (!found.ok) return found;
  const answer = (results: Fit["results"], gaps: string[] = []) => ({ ok: true as const, fit: { workflow, implementation, results, gaps } });

  if (implementation !== null) {
    const named = blockPlatforms(source, implementation);
    const used = new Map<string, Candidate>();
    for (const id of new Set(named.values())) {
      const matching = found.platforms.filter((p) => descriptionId(p.description) === id);
      if (matching.length > 1)
        return refuse(
          422,
          `Name the platform for "${id}" in platforms: ${matching.map((p) => `${p.owner.slug}/${p.slug}`).join(" and ")} both describe it.`,
        );
      if (matching.length === 1) used.set(id, matching[0]);
    }
    const given = [...used.values()].map((p) => p.description);
    const report = await engine.fit(source, given.length ? given : [NO_DESCRIPTION], implementation);
    if (report.gaps.length) return answer([], report.gaps);
    const results: BlockFit[] = report.results.map(({ platform: block, ...rest }) => {
      const p = named.has(block) ? used.get(named.get(block)!) : undefined;
      return p
        ? { block, platform: `${p.owner.slug}/${p.slug}`, number: p.number, id: named.get(block)!, label: p.label, ...rest }
        : { block, platform: null, number: null, id: null, label: null, ...rest };
    });
    for (const p of used.values()) await notePrivatePlatformView(db, viewer, p.owner, p, p.number);
    return answer(results);
  }

  const results: PlatformFit[] = [];
  for (const p of found.platforms) {
    const report = await engine.fit(source, [p.description]);
    if (report.gaps.length) return answer([], report.gaps);
    for (const { platform: id, ...rest } of report.results)
      results.push({ platform: `${p.owner.slug}/${p.slug}`, number: p.number, id, label: p.label, ...rest });
  }
  for (const p of found.platforms) await notePrivatePlatformView(db, viewer, p.owner, p, p.number);
  return answer(results);
}

// AWML's engine takes at least one description, even for an implementation
// whose blocks name none the caller may see. This one stands in: no block
// names it, so it judges nothing, and the engine still reports each block
// that names no platform, and each whose description wasn't given.
const NO_DESCRIPTION = `awml: "0.4"
platform: { id: registry-gave-no-description, label: "No description" }
off_for_up_to: PT0S
steps: code
agents: []
calls: []
holds: []
`;

// The id a platform description gives itself.
const descriptionId = (text: string) => String((readYaml(text)?.platform as { id?: unknown } | undefined)?.id);
