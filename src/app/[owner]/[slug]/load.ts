import { notFound } from "next/navigation";
import type { VersionViewProps } from "@/components/VersionView";
import { engine } from "@/engine";
import { followOldName, pageContext } from "@/server/page";
import { readVersion, VIEWS, type View } from "@/server/registry";

// One version for its page, with the asked-for view drawn (the first it has,
// when it does not have that one), or its files as text for ?view=yaml; a 404 for anyone who may not see it.
export async function loadVersion(owner: string, slug: string, n: string, asked?: string): Promise<VersionViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    const rest = `/${encodeURIComponent(slug)}${n === "latest" ? "" : `/v/${encodeURIComponent(n)}`}`;
    await followOldName(db, owner, rest, { view: asked });
    notFound();
  }
  const views = VIEWS.filter((view) => v.files[view] !== undefined);
  const shown: View | "yaml" = asked === "yaml" ? "yaml" : (views.find((view) => view === asked) ?? views[0]);
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    views,
    shown,
    files: views.map((view) => ({ view, text: v.files[view]! })),
    mermaid: shown === "yaml" ? "" : await engine.draw(v.files[shown]!),
    check: v.check,
    summary: v.summary,
    versions: v.versions,
  };
}
