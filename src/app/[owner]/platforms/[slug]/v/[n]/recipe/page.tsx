import { PlatformView } from "@/components/PlatformView";
import { loadPlatform } from "../../../load";

export default async function PlatformVersionRecipePage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return <PlatformView {...await loadPlatform(owner, slug, n, "recipe")} />;
}
