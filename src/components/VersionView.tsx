import Link from "next/link";
import type { Summary } from "@/engine";
import { mcpUrl } from "@/server/http";
import type { PageView } from "@/server/page";
import type { FileName, Origin, Referrer, View } from "@/server/registry";
import type { ShownRef } from "@/server/refs";
import { fork } from "@/app/[owner]/[slug]/actions";
import { names, stepCount } from "@/server/summary";
import { CURRENT_AWML } from "@/server/awml-file";
import { Checks, mistakesIn, Tick, type CheckedFile } from "./Checks";
import { ConvertedNote } from "./ConvertedNote";
import { CopyButton } from "./CopyButton";
import { ForkForm } from "./ForkForm";
import { Versions, type ListedVersion } from "./VersionList";
import { PanZoom } from "./PanZoom";
import { count } from "./words";

export type VersionViewProps = {
  owner: string;
  slug: string;
  title: string;
  visibility: "public" | "private";
  number: number;
  // Whether this workflow is a fork, and of which version, when the viewer
  // may see the original.
  forked: boolean;
  forkedFrom: Origin | null;
  // The forks of this workflow the viewer may see: how many, and the newest.
  forks: { total: number; forks: (Origin & { title: string; visibility: "public" | "private" })[] };
  // How the viewer may fork it: into one of their owners, or after signing
  // in. Null for a private workflow, which cannot be forked.
  fork: { owners: string[] } | { signIn: string } | null;
  // The page's address without a view: /owner/slug for the latest version,
  // /owner/slug/v/n for one version. Each view is at this address/view.
  address: string;
  // What follows the address for the view asked for, such as "/checks" or
  // "/platform/home", or "" for none or the security view, so another version
  // opens on the same tab.
  tab: string;
  views: View[];
  shown: PageView;
  // The file the shown view is drawn from.
  drawnFrom: FileName;
  // A workflow's implementations, each with the address of its platform view
  // and whether it is the one drawn. None for a version stored before 0.4.
  implementations: { id: string; label: string; href: string; shown: boolean }[];
  // A workflow's platform view when it has no implementations.
  nowhere: boolean;
  // Each file as it was pushed, and the AWML its `awml:` field gives.
  files: { name: FileName; text: string; awml: string | null }[];
  // What checking each file found, and the AWML that checked it.
  checks: CheckedFile[];
  // Each ref the workflow's file holds, as the viewer may know what it names.
  refs: ShownRef[];
  // The workflows the viewer may see whose latest version refers to this one.
  referredBy: Referrer[];
  // The shown file drawn, or "" when it is not a drawing view or the file has mistakes.
  mermaid: string;
  summary: Summary;
  versions: ListedVersion[];
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
  // Moving between the tabs is a client navigation that keeps the scroll
  // position, so only the new tab is fetched and Mermaid stays loaded.
  const tablist = (
    <div role="tablist" aria-label="View" className="tabs">
      {tabs.map((view) => (
        <Link key={view} role="tab" href={`${p.address}/${view}`} aria-selected={view === p.shown} scroll={false}>
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
        </Link>
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
            <div className="note">
              {p.visibility === "public" ? "Public" : "Private"} ·{" "}
              <Versions
                versions={p.versions}
                number={p.number}
                href={(n) => `${n === latest ? base : `${base}/v/${n}`}${p.tab}`}
              />
            </div>
            {p.fork &&
              ("owners" in p.fork ? (
                <ForkForm
                  action={fork}
                  from={`${p.owner}/${p.slug}`}
                  version={p.number}
                  slug={p.slug}
                  owners={p.fork.owners}
                />
              ) : (
                <a className="button outline fork-link" href={p.fork.signIn}>
                  Fork
                </a>
              ))}
          </div>
          {p.forked && (
            <p className="forked-from">
              {p.forkedFrom ? (
                <>
                  Forked from{" "}
                  <Link href={`/${p.forkedFrom.owner}/${p.forkedFrom.slug}/v/${p.forkedFrom.number}`}>
                    {`${p.forkedFrom.owner}/${p.forkedFrom.slug}`}
                  </Link>
                  {`, version ${p.forkedFrom.number}`}
                </>
              ) : (
                "Forked from another workflow"
              )}
            </p>
          )}
        </div>
      </section>

      {p.shown === "checks" ? (
        <div className="full">
          {tablist}
          <Checks title={p.title} files={p.checks} refs={p.refs} />
        </div>
      ) : p.shown === "yaml" ? (
        <div className="full yaml">
          {tablist}
          <div className="files" role="tabpanel" aria-label={`${p.title}, yaml`}>
            {p.files.map((f) => (
              <section key={f.name}>
                <div className="yaml-head">
                  <h2>{f.name}.yaml</h2>
                  <div className="file-actions">
                    <CopyButton target={`${f.name}-yaml`} />
                    <a href={`${base}/v/${p.number}/${f.name}.yaml`} className="button outline" download>
                      Download
                    </a>
                  </div>
                </div>
                <ConvertedNote name={`${f.name}.yaml`} awml={f.awml}>
                  The registry draws, checks and fits it converted to AWML {CURRENT_AWML}.
                </ConvertedNote>
                <pre id={`${f.name}-yaml`}>{f.text}</pre>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="wf-body">
          <main>
            {tablist}
            {p.shown === "platform" && <Implementations implementations={p.implementations} />}
            <figure className="figure" role="tabpanel" aria-label={`${p.title}, ${TAB[p.shown].toLowerCase()}`}>
              {p.nowhere ? (
                <p className="cannot-draw">This workflow doesn&apos;t say where it runs yet.</p>
              ) : p.mermaid ? (
                <PanZoom text={p.mermaid} />
              ) : (
                <CannotDraw file={p.checks.find((f) => f.name === p.drawnFrom)!} checks={`${p.address}/checks`} />
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
                  awml push {p.owner}/{p.slug} workflow.yaml
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

            {p.referredBy.length > 0 && (
              <section className="side">
                <h2>
                  Referred to by <span className="tab-count">{p.referredBy.length}</span>
                </h2>
                <ul className="forks">
                  {p.referredBy.map((r) => (
                    <li key={`${r.owner}/${r.slug}`}>
                      <Link href={`/${r.owner}/${r.slug}`}>{`${r.owner}/${r.slug}`}</Link>
                      <span className="note">
                        {` · ${r.parts.join(", ")}`}
                        {r.visibility === "private" ? " · private" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {p.forks.total > 0 && (
              <section className="side">
                <h2>
                  Forks <span className="tab-count">{p.forks.total}</span>
                </h2>
                <ul className="forks">
                  {p.forks.forks.map((f) => (
                    <li key={`${f.owner}/${f.slug}`}>
                      <Link href={`/${f.owner}/${f.slug}`}>{`${f.owner}/${f.slug}`}</Link>
                      <span className="note">
                        {` · from version ${f.number}`}
                        {f.visibility === "private" ? " · private" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {p.forks.total > p.forks.forks.length && (
                  <p className="after">The newest {p.forks.forks.length} are shown.</p>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </article>
  );
}

// Which implementation the platform view draws: a choice when there is more
// than one, moving between them as between the tabs, or the name of the only
// one.
function Implementations({ implementations }: { implementations: VersionViewProps["implementations"] }) {
  if (implementations.length === 0) return null;
  if (implementations.length === 1) return <p className="implementations">{implementations[0].label}</p>;
  return (
    <nav className="implementations" aria-label="Implementation">
      {implementations.map((i) => (
        <Link key={i.id} href={i.href} className="implementation" aria-current={i.shown ? "page" : undefined} scroll={false}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

// In place of a drawing of a file that has mistakes, which AWML will not draw.
function CannotDraw({ file, checks }: { file: CheckedFile; checks: string }) {
  return (
    <p className="cannot-draw">
      {file.name}.yaml has {count(mistakesIn([file]), "mistake", "mistakes")}, so it cannot be drawn.{" "}
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
