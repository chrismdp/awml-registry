import type { ReactNode } from "react";
import type { ListedCheck } from "@/engine";
import type { ShownRef } from "@/server/refs";
import type { FileName } from "@/server/registry";
import { CURRENT_AWML } from "@/server/awml-file";
import { count } from "./words";

// One check AWML ran on a file, the mistakes it found, none when it passed,
// and its warnings, which fail nothing. A check AWML listed at push also has
// its id, what it guards and its result; the one row of a file checked again
// with `awml check` has none of those.
export type CheckRow = {
  name: string;
  mistakes: string[];
  warnings: string[];
  listed?: Pick<ListedCheck, "id" | "about" | "result" | "skippedBecause">;
};

// A file, the checks run on it and the AWML that ran them. Listed, one row
// per check, "stored" when AWML listed them at push, or "now" when the AWML
// the registry runs listed them here. Otherwise the file was checked again
// here by `awml check`, which gives only the mistakes it finds, so it has
// one row. A system's member is named as owner/slug, the path the engine is
// given it at. A file stored in an older AWML is checked converted, and
// `notes` holds what converting it noted for its author to do by hand,
// which fails nothing.
export type CheckedFile = {
  name: FileName | `${string}/${string}`;
  rows: CheckRow[];
  checkedBy: { tag: string; commit: string };
  listed: "stored" | "now" | false;
  notes?: string[];
};

// The mistakes a row found; a listed check that failed found at least one.
const mistakesOf = (row: CheckRow) => Math.max(row.mistakes.length, row.listed?.result === "fail" ? 1 : 0);

// How many mistakes the files' checks found. None means no check failed.
export const mistakesIn = (files: CheckedFile[]) =>
  files.reduce((sum, f) => sum + f.rows.reduce((n, row) => n + mistakesOf(row), 0), 0);

export function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// What a check's result says beside its name.
function Result({ row }: { row: CheckRow }) {
  if (row.listed?.result === "skipped") return <span className="badge skipped">Skipped</span>;
  if (mistakesOf(row) > 0) return <span className="badge bad">{count(mistakesOf(row), "mistake", "mistakes")}</span>;
  if (row.listed?.result === "warn") return null;
  return (
    <span className="badge good">
      <Tick />
      {row.listed ? "Passed" : "No mistakes"}
    </span>
  );
}

// What each of a workflow's refs names: a workflow the viewer may see,
// linked; one not pushed yet; or a workflow they can't see, unnamed.
function Refs({ refs }: { refs: ShownRef[] }) {
  if (refs.length === 0) return null;
  return (
    <section className="refs">
      <div className="check-head">
        <h2>References</h2>
        <p>Checked against the latest version of each workflow you can see</p>
      </div>
      <ul className="check-rows">
        {refs.map((r) => (
          <li key={r.part} data-ref={r.state}>
            <code>{r.part}</code> refers to{" "}
            {r.state === "found" ? (
              <>
                <a href={`/${r.owner}/${r.slug}`}>{`${r.owner}/${r.slug}`}</a>#{r.id}
              </>
            ) : r.state === "missing" ? (
              `${r.owner}/${r.slug}#${r.id}, not pushed yet`
            ) : (
              "a workflow you can't see"
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// What `awml convert` noted, converting a stored file to the AWML the
// registry reads, for its author to do by hand.
export function ConvertNotes({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  return (
    <div className="check-warnings convert-notes">
      <p>Converting it to AWML {CURRENT_AWML}, awml convert noted what to do by hand. Notes don&apos;t fail the check.</p>
      <ul>
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

// What checking a version's files found, file by file, and the AWML that
// checked them. A system's page says itself how they were checked, as `intro`.
export function Checks({
  title,
  files,
  refs = [],
  intro,
}: {
  title: string;
  files: CheckedFile[];
  refs?: ShownRef[];
  intro?: ReactNode;
}) {
  const listed = files.every((f) => f.listed);
  const now = files.some((f) => f.listed === "now");
  const spec = `https://github.com/chrismdp/awml/blob/${files[0]?.checkedBy.commit}/SPEC.md#the-file-format`;
  return (
    <div className="checks" role="tabpanel" aria-label={`${title}, checks`}>
      <p className="checks-intro">
        {intro ??
          (listed ? (
            <>
              AWML checked this file when it was pushed, and the registry refuses a push with any mistake.{" "}
              {now && "It is checked again here, by the AWML this registry runs. "}Here is each check it ran, in the
              order its spec gives them.
            </>
          ) : (
            <>
              AWML checked each file when it was pushed, and the registry refuses a push with any mistake. Each file is
              checked again here, by the AWML this registry runs.
            </>
          ))}
      </p>
      <Refs refs={refs} />
      {files.map((f) => (
        <section key={f.name}>
          <div className="check-head">
            <h2>{f.name}.yaml</h2>
            <p>Checked by AWML {f.checkedBy.tag}</p>
          </div>
          <ConvertNotes notes={f.notes} />
          <ul className="check-rows">
            {f.rows.map((row) => (
              <li key={row.listed?.id ?? row.name} data-check={row.listed?.id}>
                <div className="check-row">
                  {row.listed ? (
                    <span className="check-name">
                      <strong>{row.name}</strong> <code>{row.listed.id}</code>
                    </span>
                  ) : (
                    <code>{row.name}</code>
                  )}
                  <span className="check-result">
                    <Result row={row} />
                    {row.warnings.length > 0 && (
                      <span className="badge warn">{count(row.warnings.length, "warning", "warnings")}</span>
                    )}
                  </span>
                </div>
                {row.listed && <p className="check-about">{row.listed.about}</p>}
                {row.listed?.skippedBecause && <p className="check-skipped">Skipped because {row.listed.skippedBecause}.</p>}
                {row.mistakes.length > 0 && (
                  <ul className="check-mistakes">
                    {row.mistakes.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
                {row.warnings.length > 0 && (
                  <div className="check-warnings">
                    <p>Warnings don&apos;t fail the check.</p>
                    <ul>
                      {row.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="checks-end">
        {listed ? (
          <a href={spec}>AWML&apos;s spec says what each check is for.</a>
        ) : (
          <>
            AWML lists the mistakes it finds, not each rule it checks. <a href={spec}>Its spec says what it checks for.</a>
          </>
        )}
      </p>
    </div>
  );
}
