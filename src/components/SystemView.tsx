import Link from "next/link";
import MarkdownIt from "markdown-it";
import type { Summary } from "@/engine";
import type { SystemTab } from "@/server/page";
import type { PartLink } from "@/server/part-links";
import type { Visibility } from "@/server/push";
import { names } from "@/server/summary";
import { Checks, mistakesIn, Tick, type CheckedFile } from "./Checks";
import { Drawing } from "./Drawing";
import { undrawnText, type Drawings, type Undrawn } from "./flow/drawing";
import { Versions, type ListedVersion } from "./VersionList";
import { count } from "./words";

// A member as the viewer may know it: a workflow they may see, and whether it
// is drawn; or one deleted, to those who may see into the owner it was in.
export type ListedMember =
  | { state: "found"; owner: string; slug: string; title: string; visibility: Visibility; drawn: boolean }
  | { state: "missing"; owner: string; slug: string };

// One platform judged running every member drawn.
export type SystemFit = { owner: string; slug: string; label: string; fits: boolean; reasons: string[] };

// What the tab shown holds. Each the engine works out may instead be the
// mistakes it threw, and is empty when no member is drawn.
export type SystemPanel =
  | { tab: "checks" }
  | { tab: "map"; drawing?: Drawings | Undrawn; hrefs?: Record<string, string>; links?: PartLink[]; error?: string }
  | { tab: "who-waits"; summary?: Summary; error?: string }
  | { tab: "where-it-runs"; fits?: SystemFit[]; gaps?: string[]; error?: string };

export type SystemViewProps = {
  owner: string;
  slug: string;
  title: string;
  // Markdown, as pushed.
  description: string;
  visibility: Visibility;
  number: number;
  // The page's address without a tab: /owner/systems/slug for the latest
  // version, /owner/systems/slug/v/n for one version.
  address: string;
  tab: SystemTab;
  // The members the viewer may see, in the order pushed, and how many they
  // may not.
  members: ListedMember[];
  hidden: number;
  // What checking the members together found, one file each.
  checks: CheckedFile[];
  panel: SystemPanel;
  versions: ListedVersion[];
};

const TAB: Record<SystemTab, string> = {
  map: "Map",
  checks: "Checks",
  "who-waits": "Who waits",
  "where-it-runs": "Where it runs",
};

// Markdown as HTML, with any raw HTML in it shown as text, not run.
const markdown = new MarkdownIt("default", { html: false });

export function SystemView(p: SystemViewProps) {
  const base = `/${p.owner}/systems/${p.slug}`;
  const latest = p.versions[0]?.number ?? p.number;
  const mistakes = mistakesIn(p.checks);
  const tabs = Object.keys(TAB) as SystemTab[];
  return (
    <article>
      <section className="wf-head">
        <div>
          <p className="crumb">
            <Link href={`/${p.owner}`}>{p.owner}</Link> / systems / {p.slug}
          </p>
          <h1>{p.title}</h1>
          <div className="meta">
            <div className="note">
              System · {p.visibility === "public" ? "Public" : "Private"} ·{" "}
              <Versions
                versions={p.versions}
                number={p.number}
                href={(n) => `${n === latest ? base : `${base}/v/${n}`}${p.tab === "map" ? "" : `/${p.tab}`}`}
              />
            </div>
          </div>
          {p.description && <div className="sys-description" dangerouslySetInnerHTML={{ __html: markdown.render(p.description) }} />}
        </div>
      </section>

      <div className="wf-body">
        <main>
          {p.hidden > 0 && (
            <p className="incomplete">
              This system is shown incomplete: {count(p.hidden, "of its workflows is", "of its workflows are")} private
              to you, so every tab leaves {p.hidden === 1 ? "it" : "them"} out.
            </p>
          )}
          <div role="tablist" aria-label="View" className="tabs">
            {tabs.map((tab) => (
              <a key={tab} role="tab" href={tab === "map" ? p.address : `${p.address}/${tab}`} aria-selected={tab === p.tab}>
                {TAB[tab]}
                {tab === "checks" &&
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
          <Panel {...p} />
        </main>

        <aside>
          <section className="side">
            <h2>
              Workflows <span className="tab-count">{p.members.length + p.hidden}</span>
            </h2>
            <ul className="forks members">
              {p.members.map((m) =>
                m.state === "found" ? (
                  <li key={`${m.owner}/${m.slug}`}>
                    <Link href={`/${m.owner}/${m.slug}`}>{m.title}</Link>
                    <span className="note">
                      {` · ${m.owner}/${m.slug}`}
                      {m.visibility === "private" ? " · private" : ""}
                      {m.drawn ? "" : " · not drawn"}
                    </span>
                  </li>
                ) : (
                  <li key={`${m.owner}/${m.slug}`}>
                    {`${m.owner}/${m.slug}`}
                    <span className="note"> · missing: it is no longer there, so every tab leaves it out</span>
                  </li>
                ),
              )}
              {p.hidden > 0 && <li className="note">{count(p.hidden, "private workflow", "private workflows")}</li>}
            </ul>
            {p.members.some((m) => m.state === "found" && !m.drawn) && (
              <p className="after">
                A workflow that doesn&apos;t pass check is not drawn, and is left out of the map, who waits and where it
                runs. <a href={`${p.address}/checks`}>See Checks.</a>
              </p>
            )}
          </section>
        </aside>
      </div>
    </article>
  );
}

// The tab shown.
function Panel(p: SystemViewProps) {
  const { panel } = p;
  const label = `${p.title}, ${TAB[p.tab].toLowerCase()}`;
  if (panel.tab === "checks" && p.checks.length === 0)
    return (
      <div className="figure pf-panel" role="tabpanel" aria-label={label}>
        <p className="cannot-draw">There are no workflows you can see in this system to check.</p>
      </div>
    );
  if (panel.tab === "checks")
    return (
      <Checks
        title={p.title}
        files={p.checks}
        intro="AWML checks each workflow you can see in this system, given together with the others at their latest versions, so a copy of a part that disagrees with the part it refers to is found. Here is each check it ran on each workflow, in the order its spec gives them."
      />
    );
  if (panel.error)
    return (
      <div className="figure pf-panel" role="tabpanel" aria-label={label}>
        <p className="cannot-draw">
          {notTogether(panel.error)} <a href={`${p.address}/checks`}>See Checks.</a>
        </p>
      </div>
    );
  if (panel.tab === "map")
    return (
      <figure className="figure" role="tabpanel" aria-label={label}>
        {!panel.drawing ? (
          <NoneDrawn />
        ) : "undrawn" in panel.drawing ? (
          <p className="cannot-draw">{undrawnText(panel.drawing, "map")}</p>
        ) : (
          <Drawing drawings={panel.drawing} hrefs={panel.hrefs} links={panel.links} />
        )}
      </figure>
    );
  if (panel.tab === "who-waits")
    return (
      <div className="figure pf-panel" role="tabpanel" aria-label={label}>
        {panel.summary ? <Waits summary={panel.summary} /> : <NoneDrawn />}
      </div>
    );
  return (
    <div className="figure pf-panel" role="tabpanel" aria-label={label}>
      {panel.fits && panel.gaps ? <Runs fits={panel.fits} gaps={panel.gaps} /> : <NoneDrawn />}
    </div>
  );
}

// Why a tab shows nothing, in words a system's embed (#75) says too.
export const NONE_DRAWN = "None of the workflows you can see in this system is drawn.";
export const notTogether = (error: string) => `AWML can't work this out for these workflows together: ${error}`;

function NoneDrawn() {
  return <p className="cannot-draw">{NONE_DRAWN}</p>;
}

// What waits on a person across the workflows, and the parts they share.
function Waits({ summary }: { summary: Summary }) {
  const { people } = names(summary);
  const shared = summary.shared ?? [];
  return (
    <>
      <h2>What waits on a person</h2>
      {people.length === 0 ? (
        <p className="plain">Nothing in these workflows waits on a person.</p>
      ) : (
        <ul className="waits">
          {people.map((who, i) => (
            <li key={i}>
              {who.label}
              <span className="note">{who.kind === "review" ? " · a review" : " · a person's step"}</span>
            </li>
          ))}
        </ul>
      )}
      {shared.length > 0 && (
        <>
          <h2>Shared between workflows</h2>
          <ul className="waits">
            {shared.map((part, i) => (
              <li key={i}>
                {part.label}
                <span className="note">{` · ${part.workflows.join(", ")}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

// Each platform judged running every workflow drawn, or what the workflows
// don't say that the fit needs.
function Runs({ fits, gaps }: { fits: SystemFit[]; gaps: string[] }) {
  if (gaps.length)
    return (
      <>
        <p className="plain">These workflows don&apos;t say everything the fit needs:</p>
        <ul className="waits">
          {gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </>
    );
  if (fits.length === 0) return <p className="plain">There are no platforms to fit these workflows against yet.</p>;
  return (
    <ul className="waits">
      {fits.map((f) => (
        <li key={`${f.owner}/${f.slug}`}>
          <Link href={`/${f.owner}/platforms/${f.slug}`}>{f.label}</Link>
          <span className="note">{` · ${f.owner}/platforms/${f.slug} · `}</span>
          <strong>{f.fits ? "Runs them all" : "Doesn't run them all"}</strong>
          {f.reasons.length > 0 && (
            <ul className="check-mistakes">
              {f.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
