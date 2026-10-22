import { notFound } from "next/navigation";
import type { PlatformViewProps } from "@/components/PlatformView";
import { followOldName, pageContext, platformPath, underOwner, type PlatformTab } from "@/server/page";
import { describePlatform } from "@/server/platform-description";
import { readPlatformVersion } from "@/server/platforms";

// One platform version for its page, `n` or "latest", with the tab asked
// for. A 404 for anyone who may not see it.
export async function loadPlatform(owner: string, slug: string, n: string, tab: PlatformTab): Promise<PlatformViewProps> {
  const { db, viewer } = await pageContext();
  const v = await readPlatformVersion(db, viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    await followOldName(db, owner, underOwner(slug, n, tab === "offers" ? undefined : tab), "/platforms");
    notFound();
  }
  return {
    owner: v.owner,
    slug: v.slug,
    label: v.label,
    visibility: v.visibility,
    number: v.number,
    address: platformPath(v.owner, v.slug, n === "latest" ? "latest" : v.number),
    tab,
    description: v.description,
    described: describePlatform(v.description),
    recipe: v.recipe,
    versions: v.versions,
  };
}
