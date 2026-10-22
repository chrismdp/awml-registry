import { VersionView } from "@/components/VersionView";
import { loadVersion } from "../../../load";

export default async function VersionSecurityPage({ params }: { params: Promise<{ owner: string; slug: string; n: string }> }) {
  const { owner, slug, n } = await params;
  return <VersionView {...await loadVersion(owner, slug, n, "security")} />;
}
