import Link from "next/link";
import type { Summary } from "@/engine";
import { mcpUrl } from "@/server/http";
import { dateTime, type PageView } from "@/server/page";
import type { View } from "@/server/registry";
import { names, stepCount } from "@/server/summary";
import { Checks, mistakesIn, Tick, type CheckedFile } from "./Checks";
import { CopyButton } from "./CopyButton";
import { Mermaid } from "./Mermaid";
import { count } from "./words";

export type VersionViewProps = {
  owner: string;
  slug: string;
  title: string;
  visibility: "public" | "private";
  number: number;
  // The page's address without a view: /owner/slug for the latest version,
  // /owner/slug/v/n for one version. Each view is at this address/view.
  address: string;
  views: View[];
  shown: PageView;
  files: { view: View; text: string }[];
  // What checking each file found, and the AWML that checked them.
  checks: CheckedFile[];
  checkedBy: { tag: string; commit: string };
  // The shown file drawn, or "" when it is not a drawing view or the file has mistakes.
  mermaid: string;
  summary: Summary;
  versions: { number: number; pushedAt: Date; pushedBy: string | null }[];
};

const TAB: Record<PageView, string> = {
  security: "Who may see each part",
  platform: "Where each part runs",
  yaml: "YAML",
  checks: "Checks",
};

export function VersionView(p: VersionViewProps) {
  const base = `/${p.owner}/${p.slug}`;
  const mistakes = mistakesIn(p.checks);
  const latest = p.versions[0]?.number ?? p.number;
  const s = p.summary;
  const { publishingLabels } = names(s);
  const tabs: PageView[] = [...p.views, "yaml", "checks"];
  const tablist = (
    <div role="tablist" aria-label="View" className="tabs">
      {tabs.map((view) => (
        <a key={view} role="tab" href={`${p.address}/${view}`} aria-selected={view === p.shown}>
          {TAB[view]}
          {view === "checks" &&
            (mistakes === 0 ? (
              <>
                <Tick />
                <span className="hidden-label">No mistakes</span>
              </>
            ) : (
              <>
                <span className="tab-count">{mistakes}</span>
                <span className="hidden-label">{mistakes === 1 ? "mistake" : "mistakes"}</span>
              </>
            ))}
        </a>
      ))}
    </div>
  );
  return (
    <article>
      <section className="wf-head">
        <div>
          <p className="crumb">
            <Link href={`/${p.owner}`}>{p.owner}</Link> / {p.slug}
          </p>
          <h1>{p.title}</h1>
          <div className="meta">
            <span className="note">
              {p.visibility === "public" ? "Public" : "Private"} · Version {p.number} of {latest}
            </span>
          </div>
        </div>
      </section>

      {p.shown === "checks" ? (
        <div className="full">
          {tablist}
          <Checks title={p.title} files={p.checks} checkedBy={p.checkedBy} />
        </div>
      ) : p.shown === "yaml" ? (
        <div className="full yaml">
          {tablist}
          <div className="files" role="tabpanel" aria-label={`${p.title}, yaml`}>
            {p.files.map((f) => (
              <section key={f.view}>
                <div className="yaml-head">
                  <h2>{f.view}.yaml</h2>
                  <div className="file-actions">
                    <CopyButton target={`${f.view}-yaml`} />
                    <a href={`${base}/v/${p.number}/${f.view}.yaml`} className="button outline" download>
                      Download
                    </a>
                  </div>
                </div>
                <pre id={`${f.view}-yaml`}>{f.text}</pre>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="wf-body">
          <main>
            {tablist}
            <figure className="figure" role="tabpanel" aria-label={`${p.title}, ${TAB[p.shown].toLowerCase()}`}>
              {p.mermaid ? (
                <Mermaid text={p.mermaid} />
              ) : (
                <CannotDraw file={p.checks.find((f) => f.view === p.shown)!} checks={`${p.address}/checks`} />
              )}
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

            {publishingLabels.length > 0 && (
              <section className="side">
                <h2>Leaves its scope</h2>
                <ul className="leaves">
                  {publishingLabels.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
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
                <p>
                  Connect Claude or ChatGPT to the registry and tell it what to change. It runs on your account, not
                  ours.
                </p>
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
          </aside>
        </div>
      )}
    </article>
  );
}

// In place of a drawing of a file that has mistakes, which AWML will not draw.
function CannotDraw({ file, checks }: { file: CheckedFile; checks: string }) {
  return (
    <p className="cannot-draw">
      {file.view}.yaml has {count(mistakesIn([file]), "mistake", "mistakes")}, so it cannot be drawn.{" "}
      <a href={checks}>See Checks.</a>
    </p>
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
