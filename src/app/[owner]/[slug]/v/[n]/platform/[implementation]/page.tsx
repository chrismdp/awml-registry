import { VersionView } from "@/components/VersionView";
import { loadVersion } from "../../../../load";

export default async function VersionImplementationPage({
  params,
}: {
  params: Promise<{ owner: string; slug: string; n: string; implementation: string }>;
}) {
  const { owner, slug, n, implementation } = await params;
  return <VersionView {...await loadVersion(owner, slug, n, "platform", implementation)} />;
}
