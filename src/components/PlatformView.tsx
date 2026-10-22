import Link from "next/link";
import { Fragment } from "react";
import MarkdownIt from "markdown-it";
import type { PlatformTab } from "@/server/page";
import type { OfferRow } from "@/server/platform-description";
import { CopyButton } from "./CopyButton";
import { VersionList, type ListedVersion } from "./VersionList";

export type PlatformViewProps = {
  owner: string;
  slug: string;
  label: string;
  visibility: "public" | "private";
  number: number;
  // The page's address without a tab: /platforms/owner/slug for the latest
  // version, /platforms/owner/slug/v/n for one version. Each other tab is at
  // this address/tab.
  address: string;
  tab: PlatformTab;
  description: string;
  described: { intro: string; rows: OfferRow[] };
  recipe: string | null;
  versions: ListedVersion[];
};

const TAB: Record<PlatformTab, string> = {
  offers: "What it offers",
  recipe: "Install recipe",
  yaml: "YAML",
};

// Markdown as HTML, with any raw HTML in it shown as text, not run.
const markdown = new MarkdownIt("default", { html: false });

export function PlatformView(p: PlatformViewProps) {
  const base = `/platforms/${p.owner}/${p.slug}`;
  const latest = p.versions[0]?.number ?? p.number;
  const tablist = (
    <div role="tablist" aria-label="View" className="tabs">
      {(Object.keys(TAB) as PlatformTab[]).map((tab) => (
        <a key={tab} role="tab" href={tab === "offers" ? p.address : `${p.address}/${tab}`} aria-selected={tab === p.tab}>
          {TAB[tab]}
        </a>
      ))}
    </div>
  );
  return (
    <article>
      <section className="wf-head">
        <div>
          <p className="crumb">
            <Link href={`/${p.owner}`}>{p.owner}</Link> / <Link href={`/${p.owner}/platforms`}>platforms</Link> / {p.slug}
          </p>
          <h1>{p.label}</h1>
          <div className="meta">
            <span className="note">
              Platform · {p.visibility === "public" ? "Public" : "Private"} · Version {p.number} of {latest}
            </span>
          </div>
          {p.described.intro && (
            <div className="pf-intro">
              <Said text={p.described.intro} />
            </div>
          )}
        </div>
      </section>

      {p.tab === "yaml" ? (
        <div className="full yaml">
          {tablist}
          <div className="files" role="tabpanel" aria-label={`${p.label}, yaml`}>
            <section>
              <div className="yaml-head">
                <h2>description.yaml</h2>
                <div className="file-actions">
                  <CopyButton target="description-yaml" />
                  <a href={`${base}/v/${p.number}/description.yaml`} className="button outline" download>
                    Download
                  </a>
                </div>
              </div>
              <pre id="description-yaml">{p.description}</pre>
            </section>
          </div>
        </div>
      ) : (
        <div className="wf-body">
          <main>
            {tablist}
            <div className="figure pf-panel" role="tabpanel" aria-label={`${p.label}, ${TAB[p.tab].toLowerCase()}`}>
              {p.tab === "offers" ? (
                <dl className="offers">
                  {p.described.rows.map((r) => (
                    <div key={r.label}>
                      <dt>{r.label}</dt>
                      <dd>
                        <span className="value">{r.value}</span>
                        {r.comment && <Said text={r.comment} />}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : p.recipe ? (
                <div className="recipe" dangerouslySetInnerHTML={{ __html: markdown.render(p.recipe) }} />
              ) : (
                <p className="plain">This platform has no install recipe yet.</p>
              )}
            </div>
          </main>

          <aside>
            <section className="side pf-fit">
              <h2>Check a workflow against it</h2>
              <pre>awml fit workflow.yaml {p.slug}.yaml</pre>
              <p>awml fit says whether the workflow can run here, or every reason it can&apos;t.</p>
            </section>

            {p.versions.length > 1 && (
              <section className="side">
                <h2>Versions</h2>
                <VersionList
                  versions={p.versions}
                  shown={p.number}
                  href={(n) => (n === latest ? base : `${base}/v/${n}`)}
                />
              </section>
            )}
          </aside>
        </div>
      )}
    </article>
  );
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)]/g;

// A comment from the file as plain text: a paragraph for each run of lines,
// with each web address in it as a link.
function Said({ text }: { text: string }) {
  return text.split(/\n\s*\n/).map((para, i) => {
    const words = para.split("\n").join(" ");
    const parts: (string | { url: string })[] = [];
    let at = 0;
    for (const m of words.matchAll(URL_IN_TEXT)) {
      parts.push(words.slice(at, m.index), { url: m[0] });
      at = m.index + m[0].length;
    }
    parts.push(words.slice(at));
    return (
      <p key={i} className="said">
        {parts.map((part, j) => (
          <Fragment key={j}>{typeof part === "string" ? part : <a href={part.url}>{part.url}</a>}</Fragment>
        ))}
      </p>
    );
  });
}
