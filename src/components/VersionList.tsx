import Link from "next/link";
import { When } from "./When";

export type ListedVersion = { number: number; pushedAt: Date; pushedBy: string | null; awml: string | null };

// A workflow's or platform's versions, one line each, as
// "#8 · chrismdp · Today 4:43pm · 0.4": the number, linked to that version
// unless it is the one shown, who pushed it, linked to their page, when, in
// UK time, and the AWML its file says it is.
export function VersionList({
  versions,
  shown,
  href,
}: {
  versions: ListedVersion[];
  shown: number;
  href: (number: number) => string;
}) {
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
        </li>
      ))}
    </ol>
  );
}
