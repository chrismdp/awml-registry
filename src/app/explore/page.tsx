import { Gallery } from "@/components/Gallery";
import { pageContext } from "@/server/page";
import { explore } from "@/server/registry";

export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db } = await pageContext();
  return <Gallery rows={await explore(db, q)} q={q} />;
}
