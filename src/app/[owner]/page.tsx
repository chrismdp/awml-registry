import Link from "next/link";
import { notFound } from "next/navigation";
import { dateTime, followOldName, pageContext } from "@/server/page";
import { ownerPage } from "@/server/registry";

export default async function OwnerPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner: slug } = await params;
  const { db, viewer } = await pageContext();
  const page = await ownerPage(db, viewer, slug);
  if (!page) {
    await followOldName(db, slug);
    notFound();
  }
  const { owner, member, workflows } = page;
  const isOrg = owner.type === "organisation";
  return (
    <section className="plain-page">
      <h1>{owner.name || owner.slug}</h1>
      <p>
        {owner.slug}
        {isOrg ? " · organisation" : ""}
      </p>
      <nav>
        <Link href={`/${owner.slug}/platforms`}>Platforms</Link>
        {isOrg && member && (
          <>
            {" · "}
            <Link href={`/${owner.slug}/inventory`}>Inventory</Link> ·{" "}
            <Link href={`/${owner.slug}/settings`}>Members and audit log</Link>
          </>
        )}
      </nav>
      <h2>Workflows</h2>
      {workflows.length === 0 ? (
        <p>No workflows yet.</p>
      ) : (
        <ul className="list">
          {workflows.map((w) => (
            <li key={w.slug}>
              <Link href={`/${owner.slug}/${w.slug}`}>{w.title}</Link>{" "}
              <small>
                {w.slug} · {w.visibility} · updated {dateTime(w.updatedAt)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
