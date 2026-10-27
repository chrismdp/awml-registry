import { EmbeddedDrawing } from "@/components/Embed";
import { embedOptions, notEmbedded, workflowEmbed } from "@/server/embed";
import { underOwner } from "@/server/page";

// One version's drawing, fixed, embedded on another site (#75).
export default async function VersionEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string; n: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ owner, slug, n }, search] = await Promise.all([params, searchParams]);
  const embed = await workflowEmbed(owner, slug, n, embedOptions(search));
  if (!embed) return notEmbedded(owner, underOwner(slug, n, "embed"), search);
  return <EmbeddedDrawing {...embed} />;
}
