import { PlatformList } from "@/components/Platforms";
import { pageContext } from "@/server/page";
import { visiblePlatforms } from "@/server/platforms";

// Every platform the viewer may see, newest first, searched by label or slug:
// the public ones of every owner, and their organisations' private ones.
export default async function SharedPlatformsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q ?? "";
  const { db, viewer } = await pageContext();
  const rows = await visiblePlatforms(db, viewer, q);
  const platforms = rows.map(({ owner, slug, label, visibility, number, hasRecipe }) => ({
    owner,
    slug,
    label,
    visibility,
    number,
    hasRecipe: Boolean(hasRecipe),
  }));
  return (
    <>
      <section className="gallery-head">
        <div>
          <h1>Shared platforms</h1>
          <p>
            {viewer
              ? "Public platforms from every owner, and your organisations' private ones."
              : "Public platforms from every owner."}
          </p>
        </div>
        <form action="/platforms" role="search" className="search">
          <label htmlFor="p-search" className="hidden-label">
            Search by label
          </label>
          <input id="p-search" type="search" name="q" defaultValue={q} placeholder="Search by label" />
          <button type="submit" className="button">
            Search
          </button>
        </form>
      </section>
      {platforms.length === 0 ? (
        <p className="empty">{q ? "No platform you can see has that in its label." : "No shared platforms yet."}</p>
      ) : (
        <section className="pf-page">
          <PlatformList platforms={platforms} linkOwner />
        </section>
      )}
    </>
  );
}
