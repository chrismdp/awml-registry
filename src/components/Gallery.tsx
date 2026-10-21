import Link from "next/link";
import type { Summary } from "@/engine";
import { Mermaid } from "./Mermaid";

type Card = { owner: string; slug: string; title: string; summary: Summary; mermaid: string };

export function Gallery({ cards, q }: { cards: Card[]; q: string }) {
  return (
    <>
      <section className="gallery-head">
        <div>
          <h1>Public workflows</h1>
          <p>Workflows people have drawn and shared. Borrow one and make it yours.</p>
        </div>
        <form action="/explore" role="search" className="search">
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
                <Mermaid text={c.mermaid} />
              </div>
              <div className="body">
                <div className="title">{c.title}</div>
                <div className="chips">
                  <span className="chip ai">AI {c.summary.steps.ai}</span>
                  <span className="chip code">Code {c.summary.steps.code}</span>
                  <span className="chip person">Person {c.summary.steps.person}</span>
                </div>
                <div className="address">
                  {c.owner} / {c.slug}
                </div>
              </div>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}
