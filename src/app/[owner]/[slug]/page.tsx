import { VersionView } from "@/components/VersionView";
import { followOldView, loadVersion } from "./load";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ view?: string | string[]; draw?: string | string[] }>;
}) {
  const { owner, slug } = await params;
  const asked = await searchParams;
  followOldView(owner, slug, "latest", asked.view);
  const version = await loadVersion(owner, slug, "latest");
  // ?draw=flow tries issue #62's drawing laid out in the browser.
  return <VersionView {...version} {...(asked.draw === "flow" ? { draw: "flow" as const } : {})} />;
}
