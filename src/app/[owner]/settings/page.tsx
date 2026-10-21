import { forbidden, notFound } from "next/navigation";
import { listAudit } from "@/server/audit";
import { listMembers, organisationToManage } from "@/server/organisations";
import { dateTime, pageContext } from "@/server/page";

const ACTIONS = {
  push: "push",
  private_view: "private view",
  member_joined: "joined",
  member_left: "left",
} as const;

export default async function OrgSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { owner } = await params;
  const { error, notice } = await searchParams;
  const { db, viewer } = await pageContext();
  const org = await organisationToManage(db, viewer?.id, owner);
  if (!org.ok) return org.status === 403 ? forbidden() : notFound();
  const { organisation } = org;
  const [members, audit] = await Promise.all([
    listMembers(db, organisation.id),
    listAudit(db, organisation.id),
  ]);
  return (
    <section className="plain-page">
      <h1>{organisation.name}: settings</h1>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <h2 id="members">Members</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Username</th>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.username}</td>
              <td>{m.name}</td>
              <td>{m.role}</td>
              <td>
                <form method="post" action={`/api/orgs/${organisation.slug}/members/${m.userId}/remove`}>
                  <button type="submit">{m.userId === viewer?.id ? "Leave" : "Remove"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Add a member</h3>
      <form method="post" action={`/api/orgs/${organisation.slug}/members`}>
        <label>
          Email or username <input name="identifier" required />
        </label>{" "}
        <label>
          Role{" "}
          <select name="role" defaultValue="member">
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
        </label>{" "}
        <button type="submit">Add</button>
      </form>

      <h2 id="audit">Audit log</h2>
      {audit.length === 0 ? (
        <p>Nothing yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.at)}</td>
                <td>{e.actor}</td>
                <td>{ACTIONS[e.action]}</td>
                <td>{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
