import { EmbeddedDrawing } from "@/components/Embed";
import { embedOptions, notEmbedded, workflowEmbed } from "@/server/embed";
import { underOwner } from "@/server/page";

// The latest version's drawing, embedded on another site (#75).
export default async function WorkflowEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ owner, slug }, search] = await Promise.all([params, searchParams]);
  const embed = await workflowEmbed(owner, slug, "latest", embedOptions(search));
  if (!embed) return notEmbedded(owner, underOwner(slug, "latest", "embed"), search);
  return <EmbeddedDrawing {...embed} />;
}
