import { EmbeddedDrawing } from "@/components/Embed";
import { embedOptions, notEmbedded, systemEmbed } from "@/server/embed";
import { underOwner } from "@/server/page";

// A system's map, embedded on another site (#75).
export default async function SystemEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ owner, slug }, search] = await Promise.all([params, searchParams]);
  const embed = await systemEmbed(owner, slug, embedOptions(search));
  if (!embed) return notEmbedded(owner, `/systems${underOwner(slug, "latest", "embed")}`, search);
  return <EmbeddedDrawing {...embed} />;
}
