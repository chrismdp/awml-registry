import Link from "next/link";
import { notFound } from "next/navigation";
import { count } from "@/components/words";
import type { Summary } from "@/engine";
import { pageContext } from "@/server/page";
import { inventory } from "@/server/registry";
import { hasPerson, names, stepCount } from "@/server/summary";

export default async function InventoryPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  const { db, viewer } = await pageContext();
  const inv = await inventory(db, viewer, owner);
  if (!inv) notFound();
  const { organisation, rows } = inv;
  const summaries = rows.flatMap((r) => (r.summary ? [r.summary] : []));
  const n = rows.length;
  const scopes = new Set(summaries.flatMap((s) => names(s).scopeNames));
  const leaving = summaries.reduce((sum, s) => sum + s.publishingLines.count, 0);
  return (
    <>
      <section className="inv-head">
        <nav className="org-tabs" aria-label={organisation.name}>
          <Link href={`/${organisation.slug}`}>Workflows</Link>
          <Link href={`/${organisation.slug}/inventory`} aria-current="page">
            Inventory
          </Link>
          <Link href={`/${organisation.slug}/settings#members`}>Members</Link>
          <Link href={`/${organisation.slug}/settings#audit`}>Audit log</Link>
        </nav>
        <h1>{organisation.name}&apos;s AI workflows</h1>
        <p>Where AI is, where people are, what it can see and where it runs.</p>
      </section>

      {n === 0 ? (
        <p className="empty">
          {organisation.name} has no workflows yet. Push the first one with{" "}
          <code>awml push {organisation.slug}/&lt;name&gt; security.yaml</code>
        </p>
      ) : (
        <>
          <section className="stats">
            <div className="stat ai">
              <div className="n">
                {summaries.filter((s) => s.steps.ai > 0).length} of {n}
              </div>
              <div className="what">use AI somewhere</div>
            </div>
            <div className="stat person">
              <div className="n">
                {summaries.filter((s) => !hasPerson(s)).length} of {n}
              </div>
              <div className="what">have no person in them at all</div>
            </div>
            <div className="stat">
              <div className="n">{scopes.size}</div>
              <div className="what">
                {scopes.size === 1 ? "scope" : "scopes"} touched, {count(leaving, "line leaves", "lines leave")} one
              </div>
            </div>
            <div className="stat dark">
              <div className="n">
                {rows.filter((r) => !r.hasPlatform).length} of {n}
              </div>
              <div className="what">don&apos;t say where they run yet</div>
            </div>
          </section>

          <section className="inv-table">
            <div className="box">
              <table className="inv">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: "22%" }}>Workflow</th>
                    <th scope="col" style={{ width: "14%" }}>AI</th>
                    <th scope="col" style={{ width: "20%" }}>People</th>
                    <th scope="col" style={{ width: "20%" }}>Scopes it touches</th>
                    <th scope="col" style={{ width: "24%" }}>Runs on</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.slug}>
                      <th scope="row">
                        <Link href={`/${organisation.slug}/${r.slug}`} className="wf">
                          {r.title}
                        </Link>
                        <div className="sub">{subline(r.visibility, r.summary)}</div>
                      </th>
                      {r.summary ? (
                        <>
                          <td>
                            <AI summary={r.summary} />
                          </td>
                          <td>
                            <People summary={r.summary} />
                          </td>
                          <td>
                            <Chips names={names(r.summary).scopeNames} file={r.hasSecurity} missing="No security view yet" />
                          </td>
                          <td>
                            <Chips names={names(r.summary).platformNames} file={r.hasPlatform} missing="No platform view yet" />
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className="none">
                          No version yet
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

// "Private · 2 lines leave a scope · 1 read refused"
function subline(visibility: "public" | "private", s: Summary | null) {
  const parts = [visibility === "public" ? "Public" : "Private"];
  if (s?.publishingLines.count) parts.push(count(s.publishingLines.count, "line leaves", "lines leave") + " a scope");
  if (s?.refusedReads) parts.push(count(s.refusedReads, "read", "reads") + " refused");
  return parts.join(" · ");
}

function AI({ summary }: { summary: Summary }) {
  const { ai, code, person } = summary.steps;
  if (ai > 0)
    return (
      <>
        <strong>
          {ai} of {count(stepCount(summary), "step", "steps")}
        </strong>
        <div className="said">{names(summary).aiSteps.join(", ")}</div>
      </>
    );
  const rest = code > 0 && person > 0 ? "Code and people" : code > 0 ? "Code only" : person > 0 ? "People only" : "";
  return (
    <>
      <strong>None</strong>
      {rest && <div className="said">{rest}</div>}
    </>
  );
}

function People({ summary }: { summary: Summary }) {
  if (!hasPerson(summary)) return <strong className="nobody person">Nobody</strong>;
  const people = names(summary).people;
  const { person: steps } = summary.steps;
  const { reviews } = summary;
  const what = [steps && count(steps, "person step", "person steps"), reviews && count(reviews, "review", "reviews")];
  return (
    <>
      <strong>{what.filter(Boolean).join(", ")}</strong>
      {people.map((p, i) => (
        <div key={i} className="said">
          {p.label}
        </div>
      ))}
    </>
  );
}

// The names as chips; when there are none, why.
function Chips({ names, file, missing }: { names: string[]; file: boolean; missing: string }) {
  if (!file) return <span className="none">{missing}</span>;
  if (names.length === 0) return <span className="none">None named</span>;
  return (
    <>
      {names.map((name, i) => (
        <span key={i} className="chip">
          {name}
        </span>
      ))}
    </>
  );
}
