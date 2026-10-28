import Link from "next/link";
import { VersionPicker } from "./VersionPicker";
import { When } from "./When";

export type ListedVersion = { number: number; pushedAt: Date; pushedBy: string | null; awml: string | null };

// The header's "Version 2 of 3", newest first in `versions`, which opens the
// list of them. With only one version, it is plain text.
export function Versions({
  versions,
  number,
  href,
}: {
  versions: ListedVersion[];
  number: number;
  href: (number: number) => string;
}) {
  const latest = versions[0]?.number ?? number;
  if (versions.length <= 1)
    return (
      <>
        Version {number} of {latest}
      </>
    );
  return (
    <VersionPicker number={number} latest={latest}>
      <VersionList versions={versions} shown={number} href={href} />
    </VersionPicker>
  );
}

// A workflow's or platform's versions, one line each, as
// "#8 · chrismdp · Today 4:43pm · 0.8": the number, linked to that version
// unless it is the one shown, who pushed it, linked to their page, when, in
// UK time, and the AWML its file says it is; then "Showing" for the one shown
// and "Latest" for the newest, which comes first.
export function VersionList({
  versions,
  shown,
  href,
}: {
  versions: ListedVersion[];
  shown: number;
  href: (number: number) => string;
}) {
  const latest = versions[0]?.number;
  const sep = <span className="sep"> · </span>;
  return (
    <ol className="versions">
      {versions.map((v) => (
        <li key={v.number}>
          {v.number === shown ? <strong>#{v.number}</strong> : <Link href={href(v.number)}>#{v.number}</Link>}
          {v.pushedBy && (
            <>
              {sep}
              <Link href={`/${encodeURIComponent(v.pushedBy)}`}>{v.pushedBy}</Link>
            </>
          )}
          {sep}
          <When at={v.pushedAt} />
          {v.awml && (
            <>
              {sep}
              {v.awml}
            </>
          )}
          {v.number === shown && <span className="mark">Showing</span>}
          {v.number === latest && <span className="mark">Latest</span>}
        </li>
      ))}
    </ol>
  );
}
