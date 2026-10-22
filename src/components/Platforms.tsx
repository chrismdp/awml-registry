import Link from "next/link";
import type { Owner } from "@/server/owners";
import { mcpUrl, ownUrl } from "@/server/http";

export type PlatformRow = {
  owner: string;
  slug: string;
  label: string;
  visibility: "public" | "private";
  number: number;
  hasRecipe: boolean;
};

// Platforms, each with its label linked to its page, its address, version and
// links to its page's tabs. Across owners, the address links to its owner's
// platforms.
export function PlatformList({ platforms, linkOwner = false }: { platforms: PlatformRow[]; linkOwner?: boolean }) {
  return (
    <ul className="pf-list">
      {platforms.map((p) => {
        const address = `${p.owner}/${p.slug}`;
        const page = `/platforms/${address}`;
        return (
          <li key={address} className="pf">
            <div className="label">
              <Link href={page}>{p.label}</Link>
            </div>
            <div className="address">{linkOwner ? <Link href={`/${p.owner}/platforms`}>{address}</Link> : address}</div>
            <div className="facts">{`${p.visibility === "public" ? "Public" : "Private"} · Version ${p.number}`}</div>
            <div className="files">
              <a href={page}>Description</a>
              {p.hasRecipe ? (
                <a href={`${page}/recipe`}>Install recipe</a>
              ) : (
                <span className="none">No install recipe</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// What a platform description says, field by field, as AWML's spec describes
// it ("Placing a workflow: where it can run"), and what `awml fit` does with it.
export function WhatAPlatformIs() {
  return (
    <section className="side pf-what">
      <h2>What a platform is</h2>
      <p>
        A platform description says where work can run, such as a laptop, a Mac mini or a server. It is a short YAML
        file. It names the platform and says:
      </p>
      <dl className="fields">
        <div>
          <dt>platform</dt>
          <dd>Its id and the label people see, such as &quot;My laptop&quot;.</dd>
        </div>
        <div>
          <dt>off_for_up_to</dt>
          <dd>
            How long it may be off. <code>PT0S</code> means it is always on. <code>P14D</code> suits a laptop that may be
            shut for a fortnight.
          </dd>
        </div>
        <div>
          <dt>steps</dt>
          <dd>
            What carries out the steps: <code>code</code>, when the platform runs the workflow&apos;s own code, or{" "}
            <code>agent</code>, when an agent follows instructions for each step.
          </dd>
        </div>
        <div>
          <dt>agents</dt>
          <dd>
            Whose agents run there, such as <code>anthropic</code>. An empty list means only the workflow&apos;s own
            code runs there.
          </dd>
        </div>
        <div>
          <dt>calls</dt>
          <dd>
            Whose models the workflow&apos;s code can call from there, or <code>any</code>.
          </dd>
        </div>
        <div>
          <dt>holds</dt>
          <dd>
            Which folders it holds, such as <code>notes</code>.
          </dd>
        </div>
      </dl>
      <p>
        <code>awml fit</code> checks a workflow against a platform description. It says whether the workflow can run
        there, and if not, why.
      </p>
    </section>
  );
}

// How to add a platform to an owner, or change one: through the person's own
// AI on the registry's MCP server, or by pushing the file to the API.
export function AddPlatform({ owner }: { owner: Pick<Owner, "type" | "slug"> }) {
  const ask =
    owner.type === "organisation"
      ? `Add a platform to ${owner.slug} for my laptop that holds my notes folder, then fit my workflow against it.`
      : "Add a platform for my laptop that holds my notes folder, then fit my workflow against it.";
  const push = [
    `jq -Rs '{description: .}' laptop.yaml |`,
    `  curl -X POST \\`,
    `  ${ownUrl(`/api/v1/platforms/${owner.slug}/laptop/versions`)} \\`,
    `  -H "Authorization: Bearer <token>" \\`,
    `  -H "content-type: application/json" \\`,
    `  --data-binary @-`,
  ].join("\n");
  return (
    <section className="change pf-add">
      <h2>Add or change one</h2>
      <section className="own-ai">
        <h3>Ask your own AI</h3>
        <p>Connect Claude or ChatGPT to the registry&apos;s MCP server at this address. It runs on your account, not ours.</p>
        <pre>{mcpUrl()}</pre>
        <p>Then ask it, for example:</p>
        <blockquote>{ask}</blockquote>
      </section>
      <section>
        <h3>Push from your machine</h3>
        <p>
          Push the description file with the API, using a token from <Link href="/settings/tokens">Settings</Link>.
        </p>
        <pre>{push}</pre>
      </section>
      <section>
        <h3>Each change is a new version</h3>
        <p>Each change saves a new version. The version before stays as it is. The fit always uses the latest version.</p>
      </section>
    </section>
  );
}

// The same help in short, under a list of platforms.
export function ShortHelp() {
  return (
    <section className="change pf-short">
      <div>
        <h2>Add or change a platform</h2>
        <p>
          Ask your own AI through the registry&apos;s MCP server, or push the description file with the API. Each change
          saves a new version, and the fit always uses the latest.
        </p>
      </div>
      <section className="own-ai">
        <pre>{mcpUrl()}</pre>
      </section>
    </section>
  );
}
