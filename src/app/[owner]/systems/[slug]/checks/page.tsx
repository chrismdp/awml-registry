import { SystemView } from "@/components/SystemView";
import { loadSystem } from "../load";

export default async function SystemChecksPage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  return <SystemView {...await loadSystem(owner, slug, "latest", "checks")} />;
}
