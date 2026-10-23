import { movedPlatform } from "../../load";

export default async function OldPlatformVersionPage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return movedPlatform(owner, slug, n, "offers");
}
