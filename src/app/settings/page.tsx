import Link from "next/link";
import { redirect } from "next/navigation";
import { listConnectedApps } from "@/server/connected-apps";
import { organisationsOf } from "@/server/organisations";
import { dateTime, pageContext } from "@/server/page";
import { disconnect, saveUsername } from "./actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings");
  const [orgs, apps] = await Promise.all([organisationsOf(db, viewer.id), listConnectedApps(db, viewer.id)]);
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

      <h2>Username</h2>
      <p>
        Your workflows and platforms live at <Link href={`/${viewer.username}`}>{`/${viewer.username}`}</Link>. Change your
        username and they move with you. Links to your old address will redirect to the new one until someone else
        takes your old name.
      </p>
      <form action={saveUsername}>
        <label>
          Username <input name="username" defaultValue={viewer.username} required pattern="[a-z0-9-]+" maxLength={40} />
        </label>{" "}
        <button type="submit">Save</button>
      </form>

      <h2>Connected apps</h2>
      <p>
        AI apps you have allowed to use your account through the registry&apos;s MCP server. Last used is when an app
        last renewed its access, which it does each hour it is in use.
      </p>
      <p>Disconnect an app and it cannot renew its access. Access stops within an hour.</p>
      {apps.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <div className="wide">
          <table>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Allowed</th>
                <th scope="col">Last used</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.clientId}>
                  <td>{a.name || "Unnamed app"}</td>
                  <td>{a.allowedAt ? dateTime(a.allowedAt) : "not known"}</td>
                  <td>{a.lastUsedAt ? dateTime(a.lastUsedAt) : "not known"}</td>
                  <td>
                    <form action={disconnect}>
                      <input type="hidden" name="clientId" value={a.clientId} />
                      <button type="submit">Disconnect</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
