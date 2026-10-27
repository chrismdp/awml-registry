import { SystemView } from "@/components/SystemView";
import { loadSystem } from "../../../load";

export default async function SystemVersionChecksPage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return <SystemView {...await loadSystem(owner, slug, n, "checks")} />;
}
