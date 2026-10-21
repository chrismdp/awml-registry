import { Gallery } from "@/components/Gallery";
import { engine } from "@/engine";
import { pageContext } from "@/server/page";
import { explore } from "@/server/registry";

export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db } = await pageContext();
  const rows = await explore(db, q);
  const cards = await Promise.all(rows.map(async (r) => ({ ...r, mermaid: await engine.draw(r.drawn) })));
  return <Gallery cards={cards} q={q} />;
}
