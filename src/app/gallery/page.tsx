import { Gallery } from "@/components/Gallery";
import { designDrawing } from "@/server/as-read";
import { layOut } from "@/server/drawing";
import { pageContext } from "@/server/page";
import { explore } from "@/server/registry";
import { publicSystems } from "@/server/systems";

export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db } = await pageContext();
  const rows = await explore(db, q);
  const cards = await Promise.all(
    rows.map(async (r) => {
      const text = await designDrawing(r.drawn);
      return { ...r, drawing: text ? (await layOut(text)).full : null };
    }),
  );
  return <Gallery cards={cards} systems={await publicSystems(db, q)} q={q} />;
}
