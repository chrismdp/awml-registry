import { VersionView } from "@/components/VersionView";
import { followOldView, loadVersion } from "./load";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { owner, slug } = await params;
  followOldView(owner, slug, "latest", (await searchParams).view);
  return <VersionView {...await loadVersion(owner, slug, "latest")} />;
}
