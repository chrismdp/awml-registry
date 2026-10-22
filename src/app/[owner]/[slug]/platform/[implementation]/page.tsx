import { VersionView } from "@/components/VersionView";
import { loadVersion } from "../../load";

export default async function WorkflowImplementationPage({
  params,
}: {
  params: Promise<{ owner: string; slug: string; implementation: string }>;
}) {
  const { owner, slug, implementation } = await params;
  return <VersionView {...await loadVersion(owner, slug, "latest", "platform", implementation)} />;
}
