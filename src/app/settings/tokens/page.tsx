import Link from "next/link";
import { redirect } from "next/navigation";
import { MakeTokenForm } from "@/components/MakeTokenForm";
import { SettingsMenu } from "@/components/SettingsMenu";
import { dateTime, pageContext } from "@/server/page";
import { listTokens } from "@/server/tokens";
import { makeToken, revoke } from "./actions";

export default async function TokensPage() {
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings/tokens");
  const tokens = await listTokens(db, viewer.id);
  return (
    <>
      <section className="settings-head">
        <p className="crumb">
          <Link href="/settings">settings</Link> / tokens
        </p>
        <h1>API tokens</h1>
        <p>A token lets the awml command line, or any script, push and pull as you.</p>
      </section>
      <div className="settings">
        <SettingsMenu current="tokens" />
        <div className="settings-main">
          <MakeTokenForm action={makeToken} />
          <section className="settings-card">
            <h2>Your tokens</h2>
            {tokens.length === 0 ? (
              <p className="lead">None yet.</p>
            ) : (
              <div className="settings-table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Made</th>
                      <th scope="col">Last used</th>
                      <th scope="col">
                        <span className="hidden-label">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t) => (
                      <tr key={t.id}>
                        <td className="name">{t.name}</td>
                        <td>{dateTime(t.createdAt)}</td>
                        <td>{t.lastUsedAt ? dateTime(t.lastUsedAt) : "Never"}</td>
                        <td className="act">
                          <form action={revoke}>
                            <input type="hidden" name="id" value={t.id} />
                            <button type="submit" className="button quiet">
                              Revoke
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">Revoke a token and anything using it stops working straight away.</p>
          </section>
        </div>
      </div>
    </>
  );
}
