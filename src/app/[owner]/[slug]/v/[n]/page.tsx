import { VersionView } from "@/components/VersionView";
import { followOldView, loadVersion } from "../../load";

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string; n: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { owner, slug, n } = await params;
  followOldView(owner, slug, n, (await searchParams).view);
  return <VersionView {...await loadVersion(owner, slug, n)} />;
}
