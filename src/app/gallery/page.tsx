import { Gallery } from "@/components/Gallery";
import { designGraph } from "@/server/as-read";
import { layOutLater, storedDrawing } from "@/server/drawing";
import { pageContext } from "@/server/page";
import { explore } from "@/server/registry";
import { publicSystems } from "@/server/systems";

// The gallery never lays a drawing out (issue #131): each card shows the
// whole drawing stored for its graph, or none while none is stored, and asks
// for it to be laid out and stored once the page has answered, one at a
// time, so it shows next time.
export default async function GalleryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db } = await pageContext();
  const rows = await explore(db, q);
  const unstored: string[] = [];
  const cards = await Promise.all(
    rows.map(async (r) => {
      const graph = await designGraph(r.drawn);
      const drawn = graph ? await storedDrawing(db, graph) : null;
      if (graph && !drawn) unstored.push(graph);
      return { ...r, drawing: drawn && !("undrawn" in drawn) ? drawn : null };
    }),
  );
  if (unstored.length) layOutLater(db, async () => unstored);
  return <Gallery cards={cards} systems={await publicSystems(db, q)} q={q} />;
}
