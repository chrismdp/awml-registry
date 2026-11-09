import Link from "next/link";
import type { JudgedWorkflow } from "@/server/fit";
import type { WorkflowGroup, WorkflowsTab } from "./PlatformView";
import { CHECK } from "./WhereItCanRun";
import { count, mayUse } from "./words";

// How many workflows of a group show; the rest are counted.
const SHOWN = 20;

const fit = (n: number) => (n === 1 ? "fits" : "fit");

// A platform's "Workflows that fit" tab (#125), laid out as a workflow's
// "Where it can run" tab is: how many of the workflows the viewer can see fit
// here, then each group of those that do, every answer the engine's.
export function WorkflowsThatFit({ tab, label }: { tab: WorkflowsTab; label: string }) {
  return (
    <div className="fit-panel" role="tabpanel" aria-label={`${label}, workflows that fit`}>
      <div>
        <h2 className="fit-headline">
          {`${tab.fits} of the ${count(tab.seen, "workflow", "workflows")} you can see ${fit(tab.fits)} here`}
          {tab.newest !== null && `, judged against the ${tab.newest} newest public ones`}
        </h2>
        <p className="fit-intro">
          Checked against this platform&apos;s description by AWML&apos;s engine, the same check as <code>awml fit</code>.
        </p>
        {tab.signIn && (
          <p className="fit-intro">
            <a href={tab.signIn}>Sign in</a> to check your own workflows and your organisations&apos; too.
          </p>
        )}
      </div>
      {tab.groups.length === 0 ? (
        <p className="fit-intro">There are no workflows you can see yet.</p>
      ) : (
        tab.groups.map((g) => <Group key={g.key} group={g} newest={tab.newest} />)
      )}
    </div>
  );
}

function Group({ group, newest }: { group: WorkflowGroup; newest: number | null }) {
  const fits = group.workflows.length;
  const kind = !group.public ? "private" : newest !== null ? "newest public" : "public";
  const shown = group.workflows.slice(0, SHOWN);
  const rest = fits - shown.length;
  return (
    <section className="fit-group">
      <h3>
        {group.name}
        {!group.public && <span className="fit-private">Private</span>}
      </h3>
      <p className="fit-note">
        {group.judged === 1
          ? `The one ${kind} workflow ${fits ? "fits" : "doesn't fit"}.`
          : `${fits} of the ${group.judged} ${kind} workflows ${fit(fits)}.`}
      </p>
      {shown.length > 0 && <ul className="fit-rows">{shown.map((w) => <Row key={`${w.owner}/${w.slug}`} workflow={w} />)}</ul>}
      {rest > 0 && <p className="fit-note fit-rest">{`${rest} more ${fit(rest)}.`}</p>}
    </section>
  );
}

// A workflow that fits: its title, linked to its page, and which companies
// each AI step may use here, as `awml fit` says it.
function Row({ workflow: w }: { workflow: JudgedWorkflow }) {
  return (
    <li className="fit-row fits">
      <div className="fit-name">
        <Link href={`/${encodeURIComponent(w.owner)}/${encodeURIComponent(w.slug)}`}>{w.title}</Link>
        <div className="mono">{`${w.owner}/${w.slug} · v${w.number}`}</div>
      </div>
      <span className="fit-pill">
        {CHECK}
        Fits
      </span>
      {Object.keys(w.models).length > 0 && <p className="fit-detail">{`${mayUse(w.models)}.`}</p>}
    </li>
  );
}
