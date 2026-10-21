import Link from "next/link";
import { notFound } from "next/navigation";
import { Labels } from "@/components/SummaryTable";
import { pageContext } from "@/server/page";
import { inventory } from "@/server/registry";

export default async function InventoryPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  const { db, viewer } = await pageContext();
  const inv = await inventory(db, viewer, owner);
  if (!inv) notFound();
  const { rows, totals, measures } = inv;
  // Each group's heading spans its measures.
  const groups: { name: string; span: number }[] = [];
  for (const m of measures) {
    const last = groups.at(-1);
    if (last?.name === m.group) last.span++;
    else groups.push({ name: m.group, span: 1 });
  }
  return (
    <section>
      <h1>{inv.organisation.name}: inventory</h1>
      {rows.length === 0 ? (
        <p>No workflows yet.</p>
      ) : (
        <div className="wide">
          <table>
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>
                  Workflow
                </th>
                <th scope="col" rowSpan={2}>
                  Visibility
                </th>
                <th scope="col" rowSpan={2}>
                  Version
                </th>
                {groups.map((g) => (
                  <th scope="colgroup" colSpan={g.span} key={g.name}>
                    {g.name}
                  </th>
                ))}
                <th scope="col" rowSpan={2}>
                  Publishing line labels
                </th>
              </tr>
              <tr>
                {measures.map((m) => (
                  <th scope="col" key={m.group + m.label}>
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.slug}>
                  <th scope="row">
                    <Link href={`/${owner}/${r.slug}`}>{r.title}</Link>
                  </th>
                  <td>{r.visibility}</td>
                  <td>{r.latest ?? "none"}</td>
                  {measures.map((m) => (
                    <td key={m.group + m.label}>{r.summary ? m.value(r.summary) : ""}</td>
                  ))}
                  <td>{r.summary && <Labels labels={r.summary.publishingLines.labels} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{rows.length} workflows</td>
                <td></td>
                {measures.map((m) => (
                  <td key={m.group + m.label}>{m.value(totals)}</td>
                ))}
                <td>
                  <Labels labels={totals.publishingLines.labels} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
