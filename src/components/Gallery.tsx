import Link from "next/link";
import { dateTime } from "@/server/page";

type Row = { owner: string; slug: string; title: string; updatedAt: Date };

export function Gallery({ rows, q }: { rows: Row[]; q: string }) {
  return (
    <section>
      <h1>Public workflows</h1>
      <form action="/explore" role="search">
        <label>
          Search by title <input type="search" name="q" defaultValue={q} />
        </label>{" "}
        <button type="submit">Search</button>
      </form>
      {rows.length === 0 ? (
        <p>{q ? "No public workflow has that in its title." : "No public workflows yet."}</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={`${r.owner}/${r.slug}`}>
              <Link href={`/${r.owner}/${r.slug}`}>{r.title}</Link>{" "}
              <small>
                {r.owner}/{r.slug} · updated {dateTime(r.updatedAt)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
