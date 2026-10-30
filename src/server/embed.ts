import { notFound } from "next/navigation";
import { versionProps } from "@/app/[owner]/[slug]/load";
import { systemProps } from "@/app/[owner]/systems/[slug]/load";
import { mistakeMessages, mistakesIn } from "@/components/Checks";
import { undrawnText, type Drawings, type Undrawn } from "@/components/flow/drawing";
import { NONE_DRAWN, notTogether } from "@/components/SystemView";
import { count } from "@/components/words";
import { getDb } from "@/db/client";
import { engine } from "@/engine";
import { ownUrl } from "./http";
import { followOldName } from "./page";
import type { PartLink } from "./part-links";
import { readVersion } from "./registry";
import { readSystemVersion } from "./systems";

// A drawing embedded on another site (#75): a public workflow's drawing, at
// /{owner}/{slug}/embed and /{owner}/{slug}/v/{n}/embed, or a public system's
// map, at /{owner}/systems/{slug}/embed. An embed reads no session or cookie:
// it is worked out for nobody, as for someone signed out, by the same code as
// the item's page, so it shows what someone signed out sees there, and a
// private item is the same 404 as a missing one, to everyone. awml.io's home
// page shows the same drawing inline (src/components/Embed.tsx).

// What an embed's address asks for: the security view, or with
// ?view=platform the platform view, of the implementation ?implementation=
// names or else the first, as the workflow's page picks it; and whether it
// starts with Flow only on (?flow=1).
export type EmbedOptions = { view: "security" | "platform"; implementation?: string; flow: boolean };

export type EmbedProps = {
  title: string;
  // The item's page, which the corner links to.
  href: string;
  // The registry's address, as the corner names it: awml.io on awml.io.
  host: string;
  drawing: Drawings | null;
  // Why nothing is drawn, said in the frame instead, and for a file that is
  // invalid, what makes it so, in the words of each check (#102).
  message?: string;
  mistakes?: string[];
  links: PartLink[];
  hrefs: Record<string, string>;
  // How many of a system's members are private, so left out.
  hidden: number;
  flow: boolean;
};

type Search = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const on = (value: string | undefined) => value !== undefined && value !== "0" && value !== "false";

export function embedOptions(search: Search): EmbedOptions {
  const view = first(search.view) === "platform" ? "platform" : "security";
  const implementation = view === "platform" ? first(search.implementation) : undefined;
  return { view, ...(implementation !== undefined && { implementation }), flow: on(first(search.flow)) };
}

// Nobody: whoever is asking, an embed sees what someone signed out may.
const nobody = async () => ({ db: await getDb(), viewer: null });

const host = () => new URL(ownUrl("/")).host;

// A drawing, or why there is none, said as the item's page says it.
function drawn(drawing: Drawings | Undrawn | null | undefined, what: "workflow" | "map", none: string) {
  if (!drawing) return { drawing: null, message: none };
  if ("undrawn" in drawing) return { drawing: null, message: undrawnText(drawing, what) };
  return { drawing };
}

// A public workflow's version, `n` or "latest", drawn as `options` ask; null
// when there is no such public version.
export async function workflowEmbed(owner: string, slug: string, n: string, options: EmbedOptions): Promise<EmbedProps | null> {
  // The engine starts while the database is read, as for the workflow's page.
  engine.start().catch(() => {});
  const context = await nobody();
  const v = await readVersion(context.db, context.viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) return null;
  const p = await versionProps(context, v, n, options.view === "platform" ? "platform" : undefined, options.implementation);
  const file = p.checks.find((f) => f.name === p.drawnFrom);
  const none = p.nowhere
    ? "This workflow doesn't say where it runs yet."
    : `${p.drawnFrom}.yaml has ${count(file ? mistakesIn([file]) : 0, "mistake", "mistakes")}, so it cannot be drawn.`;
  return {
    title: p.title,
    href: p.address + p.tab,
    host: host(),
    ...drawn(p.nowhere ? null : p.drawing, "workflow", none),
    ...(!p.nowhere && !p.drawing && file && { mistakes: mistakeMessages(file) }),
    links: p.links,
    hrefs: {},
    hidden: 0,
    flow: options.flow,
  };
}

// A public system's latest version, its map drawn as `options` ask; null when
// there is no such public system. A member someone signed out may not see is
// left out, and counted.
export async function systemEmbed(owner: string, slug: string, options: EmbedOptions): Promise<EmbedProps | null> {
  const context = await nobody();
  const s = await readSystemVersion(context.db, context.viewer, owner, slug, "latest");
  if (!s) return null;
  const p = await systemProps(context, s, "latest", "map");
  const { panel } = p;
  if (panel.tab !== "map") throw new Error("A system's map tab gives its map.");
  return {
    title: p.title,
    href: p.address,
    host: host(),
    ...(panel.error ? { drawing: null, message: notTogether(panel.error) } : drawn(panel.drawing, "map", NONE_DRAWN)),
    links: panel.links ?? [],
    hrefs: panel.hrefs ?? {},
    hidden: p.hidden,
    flow: options.flow,
  };
}

// The 404 an embed of anything not public gives, whatever is there. When the
// owner is a name its person gave up, it sends the browser for good to the
// same embed, `rest` after the owner, under the name they go by now, with the
// same options.
export async function notEmbedded(owner: string, rest: string, search: Search): Promise<never> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  await followOldName(await getDb(), owner, rest + (query.size ? `?${query}` : ""));
  notFound();
}
