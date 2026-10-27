import { Gallery } from "@/components/Gallery";
import { designDrawing } from "@/server/as-read";
import { pageContext } from "@/server/page";
import { explore } from "@/server/registry";

export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db } = await pageContext();
  const rows = await explore(db, q);
  const cards = await Promise.all(rows.map(async (r) => ({ ...r, mermaid: await designDrawing(r.drawn) })));
  return <Gallery cards={cards} q={q} />;
}
