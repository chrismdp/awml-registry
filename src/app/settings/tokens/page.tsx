import { redirect } from "next/navigation";
import { MakeTokenForm } from "@/components/MakeTokenForm";
import { dateTime, pageContext } from "@/server/page";
import { listTokens } from "@/server/tokens";
import { makeToken, revoke } from "./actions";

export default async function TokensPage() {
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings/tokens");
  const tokens = await listTokens(db, viewer.id);
  return (
    <section className="plain-page">
      <h1>API tokens</h1>
      <p>A token lets the awml command line, or any script, push and pull as you.</p>
      <MakeTokenForm action={makeToken} />
      <h2>Your tokens</h2>
      {tokens.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Made</th>
              <th scope="col">Last used</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{dateTime(t.createdAt)}</td>
                <td>{t.lastUsedAt ? dateTime(t.lastUsedAt) : "never"}</td>
                <td>
                  <form action={revoke}>
                    <input type="hidden" name="id" value={t.id} />
                    <button type="submit">Revoke</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
