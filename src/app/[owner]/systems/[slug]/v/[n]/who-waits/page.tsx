import { SystemView } from "@/components/SystemView";
import { loadSystem } from "../../../load";

export default async function SystemVersionWaitsPage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return <SystemView {...await loadSystem(owner, slug, n, "who-waits")} />;
}
