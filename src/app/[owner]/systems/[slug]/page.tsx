import { SystemView } from "@/components/SystemView";
import { loadSystem } from "./load";

export default async function SystemPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<{ draw?: string | string[] }>;
}) {
  const { owner, slug } = await params;
  const system = await loadSystem(owner, slug, "latest", "map");
  // ?draw=flow tries issue #62's map laid out in the browser.
  return <SystemView {...system} {...((await searchParams).draw === "flow" ? { draw: "flow" as const } : {})} />;
}
