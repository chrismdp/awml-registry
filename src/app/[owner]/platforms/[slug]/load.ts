import { notFound } from "next/navigation";
import type { PlatformViewProps, WorkflowGroup, WorkflowsTab } from "@/components/PlatformView";
import type { Db } from "@/db/client";
import { awmlOf } from "@/server/awml-file";
import { workflowsThatFit } from "@/server/fit";
import { organisationsOf } from "@/server/organisations";
import { followOldName, pageContext, platformPath, underOwner, type PlatformTab } from "@/server/page";
import { describePlatform } from "@/server/platform-description";
import { PUBLIC_JUDGED, readPlatformVersion } from "@/server/platforms";
import type { Viewer } from "@/server/viewer";

// One platform version for its page, `n` or "latest", with the tab asked
// for. A 404 for anyone who may not see it.
export async function loadPlatform(owner: string, slug: string, n: string, tab: PlatformTab): Promise<PlatformViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readPlatformVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    await followOldName(db, owner, `/platforms${underOwner(slug, n, tab === "offers" ? undefined : tab)}`);
    notFound();
  }
  const address = platformPath(v.owner, v.slug, n === "latest" ? "latest" : v.number);
  return {
    owner: v.owner,
    slug: v.slug,
    label: v.label,
    visibility: v.visibility,
    number: v.number,
    address,
    tab,
    description: v.description,
    awml: awmlOf(v.description),
    described: describePlatform(v.description),
    recipe: v.recipe,
    // Only the "Workflows that fit" tab works out the fit (#125), so no other
    // tab costs one.
    workflows: tab === "workflows" ? await workflowsTab(db, viewer, v.description, `${address}/workflows`) : null,
    versions: v.versions,
  };
}

// The "Workflows that fit" tab (#125): the workflows the engine finds this
// version's description holds, in groups: the viewer's own private
// workflows, each of their organisations', then the public ones, each
// newest first as judgedWorkflows orders them. A group shows only when it
// has a workflow judged, and counts only what the viewer may see.
async function workflowsTab(db: Db, viewer: Viewer, description: string, address: string): Promise<WorkflowsTab> {
  const [{ judged, publicCount }, organisations] = await Promise.all([
    workflowsThatFit(db, viewer, description),
    viewer ? organisationsOf(db, viewer.id) : [],
  ]);
  // An organisation's name needn't be unique, so one that another of the
  // viewer's shares is headed with its slug as well.
  const clashes = (o: { name: string; slug: string }) => organisations.some((q) => q.slug !== o.slug && q.name === o.name);
  const mine = judged.filter((w) => w.visibility === "private");
  const groups: WorkflowGroup[] = [
    { key: "own", name: "Your workflows", public: false, judged: mine.filter((w) => w.ownerType === "user") },
    ...organisations.map((o) => ({
      key: `organisation:${o.slug}`,
      name: `${clashes(o) ? `${o.name} (${o.slug})` : o.name}'s workflows`,
      public: false,
      judged: mine.filter((w) => w.ownerType === "organisation" && w.owner === o.slug),
    })),
    { key: "public", name: "Public workflows", public: true, judged: judged.filter((w) => w.visibility === "public") },
  ]
    .filter((g) => g.judged.length)
    .map(({ judged: all, ...g }) => ({ ...g, judged: all.length, workflows: all.filter((w) => w.fits) }));
  return {
    fits: judged.filter((w) => w.fits).length,
    seen: mine.length + publicCount,
    newest: publicCount > PUBLIC_JUDGED ? PUBLIC_JUDGED : null,
    groups,
    signIn: viewer ? null : `/login?${new URLSearchParams({ next: address })}`,
  };
}
