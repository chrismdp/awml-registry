import { notFound } from "next/navigation";
import type { VersionViewProps } from "@/components/VersionView";
import { engine } from "@/engine";
import { pageContext } from "@/server/page";
import { readVersion, VIEWS, type View } from "@/server/registry";

// One version for its page, with the asked-for view drawn (the first it has,
// when it does not have that one); a 404 for anyone who may not see it.
export async function loadVersion(owner: string, slug: string, n: string, asked?: string): Promise<VersionViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) notFound();
  const views = VIEWS.filter((view) => v.files[view] !== undefined);
  const shown: View = views.find((view) => view === asked) ?? views[0];
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    views,
    shown,
    mermaid: await engine.draw(v.files[shown]!),
    check: v.check,
    summary: v.summary,
    versions: v.versions,
  };
}
