import Link from "next/link";
import type { Summary } from "@/engine";
import type { Drawing } from "./flow/drawing";
import { StaticDrawing } from "./flow/StaticDrawing";

// A workflow's card: its design drawn small, laid out by the server, or null
// when the engine can't draw it.
type Card = { owner: string; slug: string; title: string; summary: Summary; drawing: Drawing | null };

// A public system, listed in its own section after the workflows.
type ListedSystem = { owner: string; slug: string; title: string };

export function Gallery({ cards, systems, q }: { cards: Card[]; systems: ListedSystem[]; q: string }) {
  return (
    <>
      <section className="gallery-head">
        <div>
          <h1>Public workflows</h1>
          <p>Workflows people have drawn and shared. Borrow one and make it yours.</p>
        </div>
        <form action="/gallery" role="search" className="search">
          <label htmlFor="g-search" className="hidden-label">
            Search by title
          </label>
          <input id="g-search" type="search" name="q" defaultValue={q} placeholder="Search by title" />
          <button type="submit" className="button">
            Search
          </button>
        </form>
      </section>
      {cards.length === 0 ? (
        <p className="empty">{q ? "No public workflow has that in its title." : "No public workflows yet."}</p>
      ) : (
        <section className="cards">
          {cards.map((c) => (
            <Link key={`${c.owner}/${c.slug}`} href={`/${c.owner}/${c.slug}`} className="card">
              <div className="thumb" aria-hidden="true">
                {c.drawing && <StaticDrawing drawing={c.drawing} id={`card-${c.owner}-${c.slug}`} />}
              </div>
              <div className="body">
                <div className="title">{c.title}</div>
                <div className="chips">
                  {c.summary.steps.ai > 0 && <span className="chip ai">AI {c.summary.steps.ai}</span>}
                  {c.summary.steps.code > 0 && <span className="chip code">Code {c.summary.steps.code}</span>}
                  {c.summary.steps.person > 0 && <span className="chip person">Person {c.summary.steps.person}</span>}
                </div>
                <div className="address">
                  {c.owner} / {c.slug}
                </div>
              </div>
            </Link>
          ))}
        </section>
      )}
      {systems.length > 0 && (
        <section className="gallery-systems">
          <h2>Systems</h2>
          <p>Several workflows drawn, checked and fitted together.</p>
          <ul className="list">
            {systems.map((s) => (
              <li key={`${s.owner}/${s.slug}`}>
                <Link href={`/${s.owner}/systems/${s.slug}`}>{s.title}</Link>{" "}
                <small>
                  {s.owner} / systems / {s.slug}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
