import Link from "next/link";
import type { CheckResult, StoredSummary } from "@/db/schema";
import { dateTime } from "@/server/page";
import type { View } from "@/server/registry";
import { Counts } from "./Counts";
import { Mermaid } from "./Mermaid";

export type VersionViewProps = {
  owner: string;
  slug: string;
  title: string;
  visibility: "public" | "private";
  number: number;
  latest: boolean;
  pushedBy: string | null;
  pushedAt: Date;
  drawings: { view: View; mermaid: string }[];
  check: CheckResult;
  summary: StoredSummary;
  versions: { number: number; pushedAt: Date; pushedBy: string | null }[];
};

export function VersionView(p: VersionViewProps) {
  const base = `/${p.owner}/${p.slug}`;
  const files = p.drawings.map((d) => `${d.view}.yaml`).join(" ");
  const problems = Object.values(p.check).flat();
  return (
    <article>
      <header>
        <p>
          <Link href={`/${p.owner}`}>{p.owner}</Link> / {p.slug}
        </p>
        <h1>{p.title}</h1>
        <p>
          Version {p.number}
          {p.latest ? " (latest)" : ""} · {p.visibility} · pushed by {p.pushedBy} on {dateTime(p.pushedAt)}
        </p>
      </header>

      {p.drawings.map((d) => (
        <section key={d.view}>
          <h2>{d.view === "security" ? "Security view" : "Platform view"}</h2>
          <Mermaid text={d.mermaid} />
          <p>
            <a href={`${base}/v/${p.number}/${d.view}.yaml`}>Download {d.view}.yaml</a>
          </p>
        </section>
      ))}

      <section>
        <h2>Check</h2>
        {problems.length === 0 ? <p>No mistakes found.</p> : <ul>{problems.map((e) => <li key={e}>{e}</li>)}</ul>}
      </section>

      <section>
        <h2>Summary</h2>
        <Counts counts={p.summary.counts} />
      </section>

      <section>
        <h2>Versions</h2>
        <ol reversed className="list">
          {p.versions.map((v) => (
            <li key={v.number}>
              {v.number === p.number ? (
                <strong>Version {v.number}</strong>
              ) : (
                <Link href={`${base}/v/${v.number}`}>Version {v.number}</Link>
              )}{" "}
              <small>
                {v.pushedBy} · {dateTime(v.pushedAt)}
              </small>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>Push the next version</h2>
        <pre>
          <code>
            awml push {p.owner}/{p.slug} {files}
            {p.visibility === "private" ? " --private" : ""}
          </code>
        </pre>
      </section>
    </article>
  );
}
