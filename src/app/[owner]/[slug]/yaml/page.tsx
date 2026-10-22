import { VersionView } from "@/components/VersionView";
import { loadVersion } from "../load";

export default async function WorkflowYamlPage({ params }: { params: Promise<{ owner: string; slug: string }> }) {
  const { owner, slug } = await params;
  return <VersionView {...await loadVersion(owner, slug, "latest", "yaml")} />;
}
