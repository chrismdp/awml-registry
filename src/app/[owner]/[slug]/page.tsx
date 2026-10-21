import { VersionView } from "@/components/VersionView";
import { loadVersion } from "./load";

export default async function WorkflowPage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  return <VersionView {...await loadVersion(owner, slug, "latest")} />;
}
