import { VersionView } from "@/components/VersionView";
import { loadVersion } from "../../load";

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string; n: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { owner, slug, n } = await params;
  const { view } = await searchParams;
  return <VersionView {...await loadVersion(owner, slug, n, view)} />;
}
