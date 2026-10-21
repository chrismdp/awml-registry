import Link from "next/link";
import { redirect } from "next/navigation";
import { organisationsOf } from "@/server/organisations";
import { pageContext } from "@/server/page";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings");
  const orgs = await organisationsOf(db, viewer.id);
  return (
    <section className="plain-page">
      <h1>Settings</h1>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p>
        Signed in as <Link href={`/${viewer.username}`}>{viewer.username}</Link> ({viewer.email}).
      </p>
      <form method="post" action="/logout">
        <button type="submit">Sign out</button>
      </form>
      <p>
        <Link href="/settings/tokens">API tokens</Link>
      </p>

      <h2>Organisations</h2>
      {orgs.length === 0 ? (
        <p>You are not in any organisation.</p>
      ) : (
        <ul className="list">
          {orgs.map((o) => (
            <li key={o.slug}>
              <Link href={`/${o.slug}`}>{o.name}</Link> <small>{o.role}</small>
            </li>
          ))}
        </ul>
      )}

      <h3>Make an organisation</h3>
      <form method="post" action="/api/orgs">
        <label>
          Name <input name="name" required />
        </label>{" "}
        <label>
          Slug <input name="slug" required pattern="[a-z0-9-]+" />
        </label>{" "}
        <button type="submit">Make it</button>
      </form>
    </section>
  );
}
