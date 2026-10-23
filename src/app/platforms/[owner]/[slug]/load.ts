import { permanentRedirect } from "next/navigation";
import { platformPath, type PlatformTab } from "@/server/page";

// A platform's pages were here, at /platforms/{owner}/{slug}, until
// 2026-10-22, when they moved to /{owner}/platforms/{slug}, the reference
// AWML 0.5 gives a platform. Each old address sends the visitor for good
// (308) to the same page there, without looking, so it says nothing about
// whether the platform exists. The page there makes its own check.
export function movedPlatform(owner: string, slug: string, n: string, tab: PlatformTab): never {
  permanentRedirect(platformPath(owner, slug, n, tab));
}
