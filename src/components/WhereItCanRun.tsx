import { Fragment } from "react";
import Link from "next/link";
import type { JudgedPlatform, Placement } from "@/server/fit";
import type { FitGroup, FitTab } from "./VersionView";
import { count, mayUse } from "./words";

// How many public platforms show before "Show N more".
const SHOWN = 5;

const CHECK = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const platformHref = (owner: string, slug: string) => `/${encodeURIComponent(owner)}/platforms/${encodeURIComponent(slug)}`;

// The "Where it can run" tab (#1), built to docs/storyboard/WhereItRuns.dc.html:
// how many of the platforms the viewer can see the design fits, then each
// group of them, every answer the engine's.
export function WhereItCanRun({ fit, title, checks }: { fit: FitTab; title: string; checks: string }) {
  if ("unfittable" in fit)
    return (
      <div className="fit-panel" role="tabpanel" aria-label={`${title}, where it can run`}>
        <p className="cannot-draw">
          This version has mistakes that make it invalid, so it can&apos;t be fitted. <a href={checks}>See Checks.</a>
        </p>
      </div>
    );
  return (
    <div className="fit-panel" role="tabpanel" aria-label={`${title}, where it can run`}>
      <div>
        <h2 className="fit-headline">
          {`Fits ${fit.fits} of the ${fit.seen} platforms you can see`}
          {fit.newest !== null && `, judged against the ${fit.newest} newest public ones`}
        </h2>
        <p className="fit-intro">
          Checked against each platform&apos;s description by AWML&apos;s engine, the same check as <code>awml fit</code>.
        </p>
        {fit.signIn && (
          <p className="fit-intro">
            <a href={fit.signIn}>Sign in</a> to check your own platforms and your organisations&apos; too.
          </p>
        )}
      </div>
      {fit.gaps.length > 0 ? (
        <section className="fit-group">
          <h3>This workflow doesn&apos;t say all the fit needs</h3>
          <ul className="fit-reasons">
            {fit.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </section>
      ) : fit.groups.length === 0 ? (
        <p className="fit-intro">There are no platforms you can see yet.</p>
      ) : (
        fit.groups.map((g) => <Group key={g.name} group={g} />)
      )}
    </div>
  );
}

function Group({ group }: { group: FitGroup }) {
  const n = group.platforms.length;
  const fits = group.platforms.filter((p) => p.fits).length;
  const shown = group.public ? group.platforms.slice(0, SHOWN) : group.platforms;
  const rest = group.platforms.slice(shown.length);
  const row = (p: JudgedPlatform) => <Row key={`${p.owner}/${p.slug}`} platform={p} shared={group.shared} />;
  return (
    <section className="fit-group">
      <h3>
        {group.name}
        {!group.public && <span className="fit-private">Private</span>}
      </h3>
      {group.public && (
        <p className="fit-note">
          {n === 1
            ? `The one public platform ${fits ? "fits" : "doesn't fit"}.`
            : `${fits === 0 ? "None" : fits} of the ${n} ${fits > 1 ? "fit" : "fits"}. Closest first.`}
        </p>
      )}
      {group.shared.length > 0 && (
        <div className="fit-shared">
          <p className="fit-shared-head">Missing from every public platform, and not repeated below</p>
          <ul>
            {group.shared.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="fit-shared-after">Describe a machine that has it, and it will show up above.</p>
        </div>
      )}
      <ul className="fit-rows">{shown.map(row)}</ul>
      {rest.length > 0 && (
        <details className="fit-more">
          <summary>{`Show ${rest.length} more`}</summary>
          <ul className="fit-rows">{rest.map(row)}</ul>
        </details>
      )}
    </section>
  );
}

// A platform judged: Fits, the companies each AI step may use there and a
// link to its install recipe, or how many things are missing, and each that
// isn't among those every public platform shares.
function Row({ platform: p, shared }: { platform: JudgedPlatform; shared: string[] }) {
  const own = p.reasons.filter((r) => !shared.includes(r));
  const href = platformHref(p.owner, p.slug);
  return (
    <li className={p.fits ? "fit-row fits" : "fit-row"}>
      <div className="fit-name">
        <Link href={href}>{p.label}</Link>
        <div className="mono">{`${p.owner}/${p.slug} · v${p.number}`}</div>
      </div>
      {p.fits ? (
        <span className="fit-pill">
          {CHECK}
          Fits
        </span>
      ) : (
        <span className="fit-missing">{count(p.reasons.length, "thing missing", "things missing")}</span>
      )}
      {p.fits ? (
        <>
          {Object.keys(p.models).length > 0 && <p className="fit-detail">{`${mayUse(p.models)}.`}</p>}
          {p.hasRecipe && (
            <div className="fit-detail">
              <Link className="button" href={`${href}/recipe`}>
                How to install it here
              </Link>
            </div>
          )}
        </>
      ) : own.length ? (
        <ul className="fit-detail fit-reasons">
          {own.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="fit-detail">Nothing else is missing.</p>
      )}
    </li>
  );
}

// Whether each implementation's placement on registered platforms fits, a
// line each. Each address is the file's own, so a platform the viewer can't
// see reads exactly as one that isn't there.
export function Placed({ placements }: { placements: Placement[] }) {
  return (
    <section className="side">
      <h2>Placed in this workflow</h2>
      <ul className="placed">
        {placements.map((pl, i) => (
          <li key={i}>
            {`${pl.implementation} puts `}
            {pl.placed.map((b, j) => {
              const [owner, , slug] = b.address.split("/");
              return (
                <Fragment key={j}>
                  {j === 0 ? "" : j === pl.placed.length - 1 ? " and " : ", "}
                  {`${b.block} on `}
                  <Link className="mono" href={platformHref(owner, slug)}>
                    {b.address}
                  </Link>
                </Fragment>
              );
            })}
            {pl.gaps.length > 0
              ? ", but the fit can't judge it:"
              : pl.fits
                ? ", and that placement fits."
                : ", and that placement doesn't fit:"}
            {(pl.gaps.length > 0 || !pl.fits) && (
              <ul className="fit-reasons">
                {(pl.gaps.length ? pl.gaps : pl.reasons).map((r, k) => (
                  <li key={k}>{r}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
