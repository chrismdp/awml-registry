import { notFound, permanentRedirect } from "next/navigation";
import { mistakesIn, type CheckedFile } from "@/components/Checks";
import type { VersionViewProps } from "@/components/VersionView";
import { engine } from "@/engine";
import { implementationsOf } from "@/server/awml-file";
import { followOldName, isPageView, pageContext, underOwner, workflowPath, type PageView } from "@/server/page";
import { readVersion, VIEWS, type FileName, type View } from "@/server/registry";

// One version for its page, `n` or "latest", with the view asked for: a view
// drawn, every file as text for "yaml", or what checking them found for
// "checks". With no view asked for, the security view is drawn, or a version
// stored before 0.4 draws the first file it has.
//
// An AWML 0.4 or 0.5 workflow is one file: its security view draws the design, and
// its platform view draws one implementation, the first unless `implementation`
// names another. A 404 for anyone who may not see the version, for an
// implementation it does not have, and for a view a version stored before
// has no file for.
//
// Each file is checked again here by the AWML the registry runs, so the page
// can name that AWML truly. A push with a mistake is refused, so the check
// saved at push found none; a newer AWML can find some.
export async function loadVersion(
  owner: string,
  slug: string,
  n: string,
  asked?: PageView,
  implementation?: string,
): Promise<VersionViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    const rest = underOwner(slug, n, asked) + (implementation ? `/${encodeURIComponent(implementation)}` : "");
    await followOldName(db, owner, rest);
    notFound();
  }
  const address = workflowPath(v.owner, v.slug, n === "latest" ? "latest" : v.number);
  const workflow = v.files.workflow;
  const implementations = workflow ? implementationsOf(workflow) : [];
  if (implementation !== undefined && !implementations.some((i) => i.id === implementation)) notFound();

  const views: View[] = workflow ? [...VIEWS] : VIEWS.filter((view) => v.files[view] !== undefined);
  if ((asked === "security" || asked === "platform") && !views.includes(asked)) notFound();
  const shown = asked ?? views[0];
  const files = (workflow ? (["workflow"] as const) : views).map((name) => ({ name, text: v.files[name]! }));
  const checks: CheckedFile[] = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      rows: [{ name: "awml check", mistakes: await engine.check(f.text), warnings: await engine.warnings(f.text) }],
    })),
  );

  // The file the shown view is drawn from, and for a 0.4 or 0.5 platform view, the
  // implementation drawn, if it has any.
  const placed = shown === "platform" ? (implementation ?? implementations[0]?.id) : undefined;
  const source: FileName | undefined = workflow ? "workflow" : views.find((view) => view === shown);
  const nowhere = Boolean(workflow) && shown === "platform" && !placed;
  const drawable = source && !nowhere && mistakesIn(checks.filter((c) => c.name === source)) === 0;
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    address,
    views,
    shown,
    drawnFrom: source ?? "workflow",
    implementations: implementations.map((i) => ({
      ...i,
      href: `${address}/platform/${encodeURIComponent(i.id)}`,
      shown: i.id === placed,
    })),
    nowhere,
    files,
    checks,
    checkedBy: engine.version,
    mermaid: drawable ? await engine.draw(v.files[source]!, workflow ? placed : undefined) : "",
    summary: v.summary,
    versions: v.versions,
  };
}

// The old address of a view, such as ?view=platform, sent for good (308) to
// the view's own path. It reads nothing first, so it answers the same for a
// private workflow as for a missing one; the page it sends to makes the check.
export function followOldView(owner: string, slug: string, n: string, asked: string | string[] | undefined) {
  if (isPageView(asked)) permanentRedirect(workflowPath(owner, slug, n, asked));
}
