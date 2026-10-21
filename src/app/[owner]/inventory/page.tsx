import Link from "next/link";
import { notFound } from "next/navigation";
import { pageContext } from "@/server/page";
import { inventory } from "@/server/registry";

export default async function InventoryPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  const { db, viewer } = await pageContext();
  const inv = await inventory(db, viewer, owner);
  if (!inv) notFound();
  return (
    <section>
      <h1>{inv.organisation.name}: inventory</h1>
      {inv.rows.length === 0 ? (
        <p>No workflows yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Visibility</th>
              <th scope="col">Version</th>
              {inv.keys.map((k) => (
                <th scope="col" key={k}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inv.rows.map((r) => (
              <tr key={r.slug}>
                <th scope="row">
                  <Link href={`/${owner}/${r.slug}`}>{r.title}</Link>
                </th>
                <td>{r.visibility}</td>
                <td>{r.latest ?? "none"}</td>
                {inv.keys.map((k) => (
                  <td key={k}>{r.counts[k] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{inv.rows.length} workflows</td>
              <td></td>
              {inv.keys.map((k) => (
                <td key={k}>{inv.totals[k]}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}
