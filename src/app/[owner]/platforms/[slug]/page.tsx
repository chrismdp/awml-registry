import { PlatformView } from "@/components/PlatformView";
import { loadPlatform } from "./load";

export default async function PlatformPage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  return <PlatformView {...await loadPlatform(owner, slug, "latest", "offers")} />;
}
