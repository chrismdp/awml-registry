import { notFound, permanentRedirect } from "next/navigation";
import { mistakesIn } from "@/components/Checks";
import type { VersionViewProps } from "@/components/VersionView";
import { engine } from "@/engine";
import { followOldName, isPageView, pageContext, underOwner, workflowPath, type PageView } from "@/server/page";
import { readVersion, VIEWS } from "@/server/registry";

// One version for its page, `n` or "latest", with the view asked for: a file
// drawn, every file as text for "yaml", or what checking them found for
// "checks". With no view asked for, the first file it has is drawn. A 404 for
// anyone who may not see it, and for a view whose file this version does not
// have.
//
// Each file is checked again here by the AWML the registry runs, so the page
// can name that AWML truly. A push with a mistake is refused, so the check
// saved at push found none; a newer AWML can find some.
export async function loadVersion(owner: string, slug: string, n: string, asked?: PageView): Promise<VersionViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    await followOldName(db, owner, underOwner(slug, n, asked));
    notFound();
  }
  const views = VIEWS.filter((view) => v.files[view] !== undefined);
  if ((asked === "security" || asked === "platform") && !views.includes(asked)) notFound();
  const shown = asked ?? views[0];
  const files = views.map((view) => ({ view, text: v.files[view]! }));
  const checks = await Promise.all(
    files.map(async (f) => ({ view: f.view, rows: [{ name: "awml check", mistakes: await engine.check(f.text) }] })),
  );
  const drawn = files.find((f) => f.view === shown);
  const drawable = drawn && mistakesIn(checks.filter((c) => c.view === drawn.view)) === 0;
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    address: workflowPath(v.owner, v.slug, n === "latest" ? "latest" : v.number),
    views,
    shown,
    files,
    checks,
    checkedBy: engine.version,
    mermaid: drawable ? await engine.draw(drawn.text) : "",
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
