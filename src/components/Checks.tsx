import type { FileName } from "@/server/registry";
import { count } from "./words";

// One check AWML ran on a file, the mistakes it found, none when it passed,
// and its warnings, which fail nothing.
export type CheckRow = { name: string; mistakes: string[]; warnings: string[] };

// A file and the checks run on it. AWML's check gives only the mistakes it
// finds, not each rule it ran, so today each file has one row, `awml check`
// itself. When AWML lists its checks, each takes a row of its own here.
export type CheckedFile = { name: FileName; rows: CheckRow[] };

export const mistakesIn = (files: CheckedFile[]) =>
  files.reduce((sum, f) => sum + f.rows.reduce((n, row) => n + row.mistakes.length, 0), 0);

export function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// What checking a version's files found, file by file, and the AWML that checked them.
export function Checks({ title, files, checkedBy }: { title: string; files: CheckedFile[]; checkedBy: { tag: string; commit: string } }) {
  return (
    <div className="checks" role="tabpanel" aria-label={`${title}, checks`}>
      <p className="checks-intro">
        AWML checked each file when it was pushed, and the registry refuses a push with any mistake. Each file is
        checked again here, by the AWML this registry runs.
      </p>
      {files.map((f) => (
        <section key={f.name}>
          <div className="check-head">
            <h2>{f.name}.yaml</h2>
            <p>Checked by AWML {checkedBy.tag}</p>
          </div>
          <ul className="check-rows">
            {f.rows.map((row) => (
              <li key={row.name}>
                <div className="check-row">
                  <code>{row.name}</code>
                  {row.mistakes.length === 0 ? (
                    <span className="badge good">
                      <Tick />
                      No mistakes
                    </span>
                  ) : (
                    <span className="badge bad">{count(row.mistakes.length, "mistake", "mistakes")}</span>
                  )}
                  {row.warnings.length > 0 && (
                    <span className="badge warn">{count(row.warnings.length, "warning", "warnings")}</span>
                  )}
                </div>
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
        AWML lists the mistakes it finds, not each rule it checks.{" "}
        <a href={`https://github.com/chrismdp/awml/blob/${checkedBy.commit}/SPEC.md#the-file-format`}>
          Its spec says what it checks for.
        </a>
      </p>
    </div>
  );
}
