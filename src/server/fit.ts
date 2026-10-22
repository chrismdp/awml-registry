// Where a workflow can run: its security view judged by the AWML engine
// against the platforms the caller may see, and never against any other.
import { parse } from "yaml";
import type { Db } from "@/db/client";
import { engine, type FitResult } from "@/engine";
import type { Owner } from "./owners";
import { findReadablePlatformVersion, notePrivatePlatformView, visiblePlatforms } from "./platforms";
import { readVersion } from "./registry";
import { refuse, type Result } from "./result";
import type { Viewer } from "./viewer";

export type FitBody = { workflow?: unknown; security?: unknown; platforms?: unknown };

// One platform's answer, under its registry address and version, with the id
// and label its description gives.
export type PlatformFit = Omit<FitResult, "platform"> & { platform: string; number: number; id: string; label: string };

export type Fit = {
  workflow: { owner: string; slug: string; number: number } | null;
  results: PlatformFit[];
  gaps: string[];
};

const REF = /^([^/@\s]+)\/([^/@\s]+)(?:@([1-9]\d{0,8}))?$/;

// owner/slug or owner/slug@version.
function reference(text: string) {
  const match = REF.exec(text);
  return match ? { owner: match[1], slug: match[2], n: match[3] ?? ("latest" as const) } : null;
}

// The security view the fit judges: a stored workflow's, or the YAML sent.
async function securityView(
  db: Db,
  viewer: Viewer,
  body: FitBody,
): Promise<Result<{ security: string; workflow: Fit["workflow"] }>> {
  const { workflow, security } = body;
  if (workflow !== undefined && security !== undefined)
    return refuse(422, "Send a workflow or the YAML of its security view, not both.");
  if (typeof workflow === "string") {
    const ref = reference(workflow);
    if (!ref) return refuse(422, "Name the workflow as owner/slug or owner/slug@version.");
    const v = await readVersion(db, viewer, ref.owner, ref.slug, ref.n);
    if (!v) return refuse(404, `Not found: ${workflow}.`);
    if (v.files.security === undefined)
      return refuse(422, `${v.owner}/${v.slug} v${v.number} has no security view, which the fit needs.`);
    return { ok: true, security: v.files.security, workflow: { owner: v.owner, slug: v.slug, number: v.number } };
  }
  if (typeof security === "string") {
    const found = await engine.check(security);
    if (found.length) return refuse(422, ...found.map((e) => `security: ${e}`));
    const doc = parse(security) as { view?: string };
    if (doc.view !== "security")
      return refuse(
        422,
        `security: this is ${doc.view ? `a ${doc.view} view` : "a platform description"}; the fit needs the security view.`,
      );
    return { ok: true, security, workflow: null };
  }
  if (workflow !== undefined) return refuse(422, "Name the workflow as owner/slug or owner/slug@version.");
  return refuse(422, "Send a workflow as owner/slug, or the YAML of its security view.");
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

// Fits a workflow, named as owner/slug[@version] or sent as the YAML of its
// security view, against the platforms named, or every platform the viewer
// may see. Each platform is judged on its own, so one platform's description
// never touches another's answer, and each private one judged is recorded as
// viewed in its organisation's audit log.
export async function fitWorkflow(db: Db, viewer: Viewer, body: FitBody): Promise<Result<{ fit: Fit }>> {
  const view = await securityView(db, viewer, body);
  if (!view.ok) return view;
  const found = await candidates(db, viewer, body.platforms);
  if (!found.ok) return found;

  const results: PlatformFit[] = [];
  for (const p of found.platforms) {
    const report = await engine.fit(view.security, [p.description]);
    if (report.gaps.length) return { ok: true, fit: { workflow: view.workflow, results: [], gaps: report.gaps } };
    for (const { platform: id, ...answer } of report.results)
      results.push({ platform: `${p.owner.slug}/${p.slug}`, number: p.number, id, label: p.label, ...answer });
  }
  for (const p of found.platforms) await notePrivatePlatformView(db, viewer, p.owner, p, p.number);
  return { ok: true, fit: { workflow: view.workflow, results, gaps: [] } };
}
