import { VersionView } from "@/components/VersionView";
import { loadVersion } from "./load";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { owner, slug } = await params;
  const { view } = await searchParams;
  return <VersionView {...await loadVersion(owner, slug, "latest", view)} />;
}
