import { notFound } from "next/navigation";
import type { VersionViewProps } from "@/components/VersionView";
import { engine } from "@/engine";
import { pageContext } from "@/server/page";
import { readVersion, VIEWS } from "@/server/registry";

// One version for its page, drawn; a 404 for anyone who may not see it.
export async function loadVersion(owner: string, slug: string, n: string): Promise<VersionViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) notFound();
  const drawings = [];
  for (const view of VIEWS) {
    const text = v.files[view];
    if (text !== undefined) drawings.push({ view, mermaid: await engine.draw(text) });
  }
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    latest: v.versions[0]?.number === v.number,
    pushedBy: v.pushedBy,
    pushedAt: v.pushedAt,
    drawings,
    check: v.check,
    summary: v.summary,
    versions: v.versions,
  };
}
