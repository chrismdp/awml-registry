import Link from "next/link";
import type { CheckResult } from "@/db/schema";
import type { Summary } from "@/engine";
import { mcpUrl } from "@/server/http";
import { dateTime } from "@/server/page";
import type { View } from "@/server/registry";
import { names, stepCount } from "@/server/summary";
import { Mermaid } from "./Mermaid";
import { count } from "./words";

export type VersionViewProps = {
  owner: string;
  slug: string;
  title: string;
  visibility: "public" | "private";
  number: number;
  views: View[];
  shown: View;
  mermaid: string;
  check: CheckResult;
  summary: Summary;
  versions: { number: number; pushedAt: Date; pushedBy: string | null }[];
};

const TAB: Record<View, string> = { security: "Who may see each part", platform: "Where each part runs" };

export function VersionView(p: VersionViewProps) {
  const base = `/${p.owner}/${p.slug}`;
  const problems = Object.values(p.check).flat();
  const latest = p.versions[0]?.number ?? p.number;
  const s = p.summary;
  const { publishingLabels } = names(s);
  return (
    <article>
      <section className="wf-head">
        <div>
          <p className="crumb">
            <Link href={`/${p.owner}`}>{p.owner}</Link> / {p.slug}
          </p>
          <h1>{p.title}</h1>
          <div className="meta">
            {problems.length === 0 ? (
              <span className="badge good">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                No mistakes
              </span>
            ) : (
              <span className="badge bad">{count(problems.length, "mistake", "mistakes")}</span>
            )}
            <span className="note">
              {p.visibility === "public" ? "Public" : "Private"} · Version {p.number} of {latest}
            </span>
          </div>
        </div>
        <div className="actions">
          <a href="#change" className="button">
            Change this workflow
          </a>
          <a href={`${base}/v/${p.number}/${p.shown}.yaml`} className="button outline">
            Download YAML
          </a>
        </div>
      </section>

      {problems.length > 0 && (
        <ul className="mistakes" role="alert">
          {problems.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="wf-body">
        <main>
          <div role="tablist" aria-label="View" className="tabs">
            {p.views.map((view) => (
              <a key={view} role="tab" href={`?view=${view}`} aria-selected={view === p.shown}>
                {TAB[view]}
              </a>
            ))}
          </div>
          <figure className="figure" role="tabpanel" aria-label={`${p.title}, ${TAB[p.shown].toLowerCase()}`}>
            <Mermaid text={p.mermaid} />
          </figure>
        </main>

        <aside>
          <section className="side">
            <h2>Who decides</h2>
            <Deciders summary={s} />
          </section>

          <section className="side">
            <h2>Outside actions</h2>
            <dl className="tiers">
              <div>
                <dt>Allow</dt>
                <dd>{s.outsideActions.allow}</dd>
              </div>
              <div>
                <dt>Ask</dt>
                <dd>{s.outsideActions.ask}</dd>
              </div>
              <div>
                <dt>Block</dt>
                <dd>{s.outsideActions.block}</dd>
              </div>
            </dl>
          </section>

          <section className="side">
            <h2>Leaves its scope</h2>
            {publishingLabels.length === 0 ? (
              <p className="plain">Nothing leaves its scope.</p>
            ) : (
              <ul className="leaves">
                {publishingLabels.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="side">
            <h2>Everything in it</h2>
            <dl className="counts">
              {(
                [
                  ["Triggers", s.triggers],
                  ["Reviews", s.reviews],
                  ["Notes", s.contexts],
                  ["Connectors", s.connectors],
                  ["Surfaces", s.surfaces],
                  ["Scopes", s.scopes],
                ] as const
              ).map(([label, n]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{n}</dd>
                </div>
              ))}
            </dl>
          </section>

          {p.versions.length > 1 && (
            <section className="side">
              <h2>Versions</h2>
              <ol className="versions">
                {p.versions.map((v) => (
                  <li key={v.number}>
                    {v.number === p.number ? (
                      <strong>Version {v.number}</strong>
                    ) : (
                      <Link href={v.number === latest ? base : `${base}/v/${v.number}`}>Version {v.number}</Link>
                    )}{" "}
                    <small>
                      {v.pushedBy} · {dateTime(v.pushedAt)}
                    </small>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section id="change" className="change">
            <div>
              <h2>Change it</h2>
              <p>
                Every change is checked, then saved as version {latest + 1}. Version {latest} stays as it is.
              </p>
            </div>
            <section className="own-ai">
              <h3>Ask your own AI</h3>
              <p>Connect Claude or ChatGPT to the registry and tell it what to change. It runs on your account, not ours.</p>
              <pre>{mcpUrl()}</pre>
            </section>
            <section>
              <h3>Push from your machine</h3>
              <pre>
                awml push {p.owner}/{p.slug} {p.views.map((v) => `${v}.yaml`).join(" ")}
                {p.visibility === "private" ? " --private" : ""}
              </pre>
            </section>
          </section>
        </aside>
      </div>
    </article>
  );
}

// A bar split by who decides the steps, AI, code or a person, and a line on people.
function Deciders({ summary }: { summary: Summary }) {
  const { ai, code, person } = summary.steps;
  if (stepCount(summary) === 0) return <p className="after">This workflow has no steps.</p>;
  return (
    <>
      <div className="deciders">
        {ai > 0 && (
          <div className="ai" style={{ flex: `${ai} 1 0` }}>
            {ai} AI
          </div>
        )}
        {code > 0 && (
          <div className="code" style={{ flex: `${code} 1 0` }}>
            {code} code
          </div>
        )}
        {person > 0 && (
          <div className="person" style={{ flex: `${person} 1 0` }}>
            {person} person
          </div>
        )}
      </div>
      <p className="after">
        {person === 0
          ? "No step is decided by a person."
          : person === 1
            ? "1 step is decided by a person."
            : `${person} steps are decided by a person.`}
      </p>
    </>
  );
}
