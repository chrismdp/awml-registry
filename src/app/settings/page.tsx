import Link from "next/link";
import { redirect } from "next/navigation";
import { SettingsMenu } from "@/components/SettingsMenu";
import { listConnectedApps } from "@/server/connected-apps";
import { mcpUrl, ownAddress } from "@/server/http";
import { organisationsOf } from "@/server/organisations";
import { When } from "@/components/When";
import { pageContext } from "@/server/page";
import { listTokens } from "@/server/tokens";
import { signedInWith } from "@/server/viewer";
import { disconnect, saveUsername } from "./actions";

const ROLES = { owner: "Owner", member: "Member" } as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings");
  const [orgs, apps, tokens, provider] = await Promise.all([
    organisationsOf(db, viewer.id),
    listConnectedApps(db, viewer.id),
    listTokens(db, viewer.id),
    signedInWith(db, viewer.id),
  ]);
  const prefix = ownAddress("/");
  return (
    <>
      <section className="settings-head">
        <h1>Settings</h1>
        <p>
          Signed in as {viewer.email} with {provider}.
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
      <div className="settings">
        <SettingsMenu current="account" />
        <div className="settings-main">
          <section id="account" className="settings-card">
            <h2>Your username</h2>
            <p className="lead">
              Your workflows and platforms live at <Link href={`/${viewer.username}`}>{ownAddress(`/${viewer.username}`)}</Link>.
              Change it and they move with you. Old links redirect until someone else takes the name.
            </p>
            <form className="fields-row" action={saveUsername}>
              <label className="field">
                Username
                <span className="prefixed">
                  <span>{prefix}</span>
                  <input
                    name="username"
                    defaultValue={viewer.username}
                    required
                    pattern="[a-z0-9\-]+"
                    maxLength={40}
                  />
                </span>
              </label>
              <button type="submit" className="button">
                Save
              </button>
            </form>
            <p className="hint">Lower-case letters, digits and hyphens.</p>
            <div className="sign-out">
              <p>Signed in with {provider}. Signing out here does not disconnect your AI apps.</p>
              <form method="post" action="/logout">
                <button type="submit" className="button outline">
                  Sign out
                </button>
              </form>
            </div>
          </section>

          <section id="apps" className="settings-card">
            <h2>Connected apps</h2>
            <p className="lead">
              AI apps you have let use your account through {ownAddress("/mcp")}. Disconnect one and its access stops
              within an hour.
            </p>
            {apps.length === 0 ? (
              <p className="lead">None yet.</p>
            ) : (
              <div className="settings-table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">App</th>
                      <th scope="col">Allowed</th>
                      <th scope="col">Last used</th>
                      <th scope="col">
                        <span className="hidden-label">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {apps.map((a) => (
                      <tr key={a.clientId}>
                        <td className="name">{a.name || "Unnamed app"}</td>
                        <td>{a.allowedAt ? <When at={a.allowedAt} /> : "not known"}</td>
                        <td>{a.lastUsedAt ? <When at={a.lastUsedAt} /> : "not known"}</td>
                        <td className="act">
                          <form action={disconnect}>
                            <input type="hidden" name="clientId" value={a.clientId} />
                            <button type="submit" className="button quiet">
                              Disconnect
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">To connect another, add {mcpUrl()} as a connector in your AI app.</p>
          </section>

          <section className="settings-card summary">
            <div>
              <h2>API tokens</h2>
              <p className="lead">
                For the awml command line and scripts. You have {tokens.length === 0 ? "none" : tokens.length}.
              </p>
            </div>
            <Link href="/settings/tokens" className="button outline">
              Manage tokens
            </Link>
          </section>

          <section id="orgs" className="settings-card">
            <h2>Organisations</h2>
            <p className="lead">An organisation keeps its workflows and platforms together, and private to its members.</p>
            {orgs.length === 0 ? (
              <p className="lead">You are not in any organisation.</p>
            ) : (
              <ul className="settings-orgs">
                {orgs.map((o) => (
                  <li key={o.slug}>
                    <div>
                      <Link href={`/${o.slug}`}>{o.name}</Link> <span className="address">{ownAddress(`/${o.slug}`)}</span>
                    </div>
                    <span className="chip">{ROLES[o.role]}</span>
                  </li>
                ))}
              </ul>
            )}
            <h3>Make an organisation</h3>
            <form className="fields-row" method="post" action="/api/orgs">
              <label className="field">
                Name
                <input name="name" placeholder="Acme" required />
              </label>
              <label className="field">
                Address
                <span className="prefixed">
                  <span>{prefix}</span>
                  <input name="slug" placeholder="acme" required pattern="[a-z0-9\-]+" />
                </span>
              </label>
              <button type="submit" className="button">
                Make it
              </button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}
