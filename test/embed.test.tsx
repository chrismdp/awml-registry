// Embedding a drawing on another site (#75): /{owner}/{slug}/embed, /{owner}/{slug}/v/{n}/embed
// and /{owner}/systems/{slug}/embed show a public workflow's or system's drawing alone, with a
// link to its page in the corner, every link opening a new tab. An embed reads no session or
// cookie, so it shows what someone signed out sees, and a private item is a 404 to everyone.
// Which addresses may be framed by another site is in test/frame-headers.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WorkflowEmbed from "@/app/[owner]/[slug]/embed/page";
import VersionEmbed from "@/app/[owner]/[slug]/v/[n]/embed/page";
import SystemEmbed from "@/app/[owner]/systems/[slug]/embed/page";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import { PartMenu } from "@/components/PartLinks";
import { ownUrl } from "@/server/http";
import { drawing, expected, laidOut } from "./drawn";
import { example, orgWith, person, request, type Who } from "./helpers";
import { pageRequest, renderPage, sealed, type Page } from "./pages";

const dinners = example("dinners.yaml");
const HOST = new URL(ownUrl("/")).host;

// A workflow with two implementations, so the platform view has one to pick.
const twoPlaces = `awml: "0.6"
title: Shopping
parts:
  - { id: list, kind: context, label: "Shopping list" }
  - { id: add, kind: code, op: do, label: "Add what's run out" }
lines:
  - { from: add, to: list, kind: data }
implementations:
  home:
    label: At home
    blocks:
      - { id: server, label: "Home server", parts: [list, add] }
  away:
    label: Away
    blocks:
      - { id: phone, label: "A phone", parts: [list, add] }
`;

// A workflow that keeps its own copy of the shopping list, by a ref.
const referring = `awml: "0.6"
title: Dinners
parts:
  - { id: list, kind: context, label: "Shopping list", ref: acme/shopping#list }
  - { id: plan, kind: ai, label: "Plan the week's dinners" }
lines:
  - { from: list, to: plan, kind: data }
`;

async function pushed(owner: string, slug: string, as: Who, workflow: string, visibility: "public" | "private" = "public") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow, visibility } });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function pushedSystem(owner: string, slug: string, as: Who, json: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/${owner}/systems/${slug}/versions`, { as, json });
  expect(res.status, await res.clone().text()).toBe(201);
}

// An embed page as a browser on another site would get it: its request's headers can't be read,
// so rendering it proves it reads no session or cookie.
const embedded = <P,>(page: Page<P>, params: P, search: Record<string, string> = {}) =>
  renderPage(page, params, { search, headers: sealed });

// The site's navigation, which an embed never shows.
const SITE = /site-header|site-nav|<nav\b|Sign in|Inventory|Gallery/;

// Every link in a page, with its target and rel.
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
    href: /href="([^"]*)"/.exec(tag)?.[1],
    target: /target="([^"]*)"/.exec(tag)?.[1],
    rel: /rel="([^"]*)"/.exec(tag)?.[1],
  }));

// The link in the corner, to the full page.
const corner = (html: string) => {
  const tag = /<a class="embed-link"[^>]*>([^]*?)<\/a>/.exec(html);
  if (!tag) return null;
  return { ...links(tag[0])[0], text: tag[1].replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'") };
};

// Ana owns acme. Bea belongs to nothing.
async function world() {
  const ana = await person("ana");
  const bea = await person("bea");
  await orgWith("acme", ana);
  return { ana, bea };
}

describe("a workflow's embed", () => {
  it("draws the latest version's security view alone, filling the frame, with no site navigation", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners);
    const page = await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" });
    expect(page.status).toBe(200);
    expect(drawing(page.html)).toEqual(expected(dinners));
    expect(page.html).toMatch(/<div class="embed"/);
    expect(page.html).not.toMatch(SITE);
  });

  it("links to the workflow's page from its corner, in a new tab, by its title and the registry's address", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners);
    const page = await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" });
    expect(corner(page.html)).toEqual({
      href: "/acme/dinners",
      target: "_blank",
      rel: "noopener",
      text: `The family's dinners · ${HOST}`,
    });
  });

  it("draws one version, fixed, at /v/{n}/embed, and links to that version's page", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces.replace("Add what's run out", "Add what the week needs"));
    const first = await embedded(VersionEmbed, { owner: "acme", slug: "shopping", n: "1" });
    expect(first.status).toBe(200);
    expect(drawing(first.html)).toEqual(expected(twoPlaces));
    expect(corner(first.html)).toMatchObject({ href: "/acme/shopping/v/1", target: "_blank" });
    const latest = await embedded(WorkflowEmbed, { owner: "acme", slug: "shopping" });
    expect(drawing(latest.html)!.parts.add).toBe("Add what the week needs");
    expect((await embedded(VersionEmbed, { owner: "acme", slug: "shopping", n: "3" })).status).toBe(404);
  });

  it("gives a private workflow the same 404 as a missing one, signed in as its owner too, reading no session", async () => {
    const { ana } = await world();
    await pushed("acme", "secret", { token: ana.token }, dinners, "private");
    const answers = [];
    for (const slug of ["secret", "missing"]) {
      answers.push(await embedded(WorkflowEmbed, { owner: "acme", slug }));
      answers.push(await embedded(VersionEmbed, { owner: "acme", slug, n: "1" }));
      // Signed in as Ana, who owns it: the embed never looks at who is asking.
      answers.push(await renderPage(WorkflowEmbed, { owner: "acme", slug }, { as: ana }));
      answers.push(await renderPage(VersionEmbed, { owner: "acme", slug, n: "1" }, { as: ana }));
    }
    for (const answer of answers) expect(answer).toEqual({ status: 404, html: "" });
  });

  it("follows an owner's old name to the same embed under their new one, keeping its options", async () => {
    const { ana } = await world();
    await pushed("ana", "dinners", { token: ana.token }, dinners);
    const renamed = await request("PATCH", "/api/v1/me", { as: { token: ana.token }, json: { username: "ana-new" } });
    expect(renamed.status).toBe(200);
    const old = await embedded(WorkflowEmbed, { owner: "ana", slug: "dinners" }, { view: "platform", flow: "1" });
    expect(old).toMatchObject({ status: 308, location: "/ana-new/dinners/embed?view=platform&flow=1" });
    const version = await embedded(VersionEmbed, { owner: "ana", slug: "dinners", n: "1" });
    expect(version).toMatchObject({ status: 308, location: "/ana-new/dinners/v/1/embed" });
  });
});

describe("an embed's options, in its address", () => {
  it("draw the security view, with Flow only off, when none is given", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners);
    const { html } = await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" });
    expect(drawing(html)).toEqual(expected(dinners));
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Flow only</);
  });

  it("draw the platform view with ?view=platform: the first implementation, or the one named, as the page picks it", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    const first = await embedded(WorkflowEmbed, { owner: "acme", slug: "shopping" }, { view: "platform" });
    expect(drawing(first.html)).toEqual(expected(twoPlaces, "home"));
    expect(corner(first.html)).toMatchObject({ href: "/acme/shopping/platform" });
    const away = await embedded(WorkflowEmbed, { owner: "acme", slug: "shopping" }, { view: "platform", implementation: "away" });
    expect(drawing(away.html)).toEqual(expected(twoPlaces, "away"));
    expect(corner(away.html)).toMatchObject({ href: "/acme/shopping/platform/away" });
    const fixed = await embedded(VersionEmbed, { owner: "acme", slug: "shopping", n: "1" }, { view: "platform", implementation: "away" });
    expect(drawing(fixed.html)).toEqual(expected(twoPlaces, "away"));
    expect(corner(fixed.html)).toMatchObject({ href: "/acme/shopping/v/1/platform/away" });
    // An implementation the version doesn't have is a 404, as on the page.
    const none = await embedded(WorkflowEmbed, { owner: "acme", slug: "shopping" }, { view: "platform", implementation: "moon" });
    expect(none.status).toBe(404);
  });

  it("say so in the frame when the platform view has nowhere to draw", async () => {
    const { ana } = await world();
    await pushed("acme", "plan", { token: ana.token }, dinners.slice(0, dinners.indexOf("implementations:")));
    const { status, html } = await embedded(WorkflowEmbed, { owner: "acme", slug: "plan" }, { view: "platform" });
    expect(status).toBe(200);
    expect(html).toContain("This workflow doesn&#x27;t say where it runs yet.");
    expect(drawing(html)).toBeNull();
    expect(corner(html)).toMatchObject({ href: "/acme/plan/platform", target: "_blank" });
  });

  it("start with Flow only on with ?flow=1, drawing its own layout", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners);
    const flow = await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" }, { flow: "1" });
    expect(flow.html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Flow only</);
    // Flow only leaves out the contexts, such as the meal plan.
    expect(drawing(flow.html)!.parts).not.toHaveProperty("mealplan");
    expect(drawing(flow.html)!.parts).toHaveProperty("plan");
    const off = await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" }, { flow: "0" });
    expect(off.html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Flow only</);
  });
});

describe("a system's embed", () => {
  it("draws the map of its members, with no site navigation, linking to the system's page from its corner", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    await pushed("acme", "dinners", { token: ana.token }, referring);
    await pushedSystem("acme", "kitchen", { token: ana.token }, { title: "The kitchen", members: ["acme/shopping", "acme/dinners"] });
    const page = await embedded(SystemEmbed, { owner: "acme", slug: "kitchen" });
    expect(page.status).toBe(200);
    expect(drawing(page.html)!.scopes).toEqual(expect.arrayContaining(["w1", "w2"]));
    expect(page.html).not.toMatch(SITE);
    expect(corner(page.html)).toEqual({ href: "/acme/systems/kitchen", target: "_blank", rel: "noopener", text: `The kitchen · ${HOST}` });
    const options = await embedded(SystemEmbed, { owner: "acme", slug: "kitchen" }, { flow: "1" });
    expect(options.html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Flow only</);
  });

  it("gives a private system the same 404 as a missing one, signed in as its owner too", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    await pushedSystem("acme", "kitchen", { token: ana.token }, { title: "The kitchen", members: ["acme/shopping"], visibility: "private" });
    for (const slug of ["kitchen", "missing"]) {
      expect(await embedded(SystemEmbed, { owner: "acme", slug })).toEqual({ status: 404, html: "" });
      expect(await renderPage(SystemEmbed, { owner: "acme", slug }, { as: ana })).toEqual({ status: 404, html: "" });
    }
  });

  it("shows a private member as 1 private workflow and nothing of it, as someone signed out sees the system, even to its owner", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    await pushed("ana", "notes", { token: ana.token }, twoPlaces.replace("title: Shopping", "title: Secret notes").replaceAll("Shopping list", "Secret notes list"), "private");
    await pushedSystem("ana", "home", { token: ana.token }, { title: "Home", members: ["acme/shopping", "ana/notes"] });
    const signedOut = await renderPage(SystemPage, { owner: "ana", slug: "home" });
    expect(signedOut.html).toContain("1 private workflow");
    for (const page of [await embedded(SystemEmbed, { owner: "ana", slug: "home" }), await renderPage(SystemEmbed, { owner: "ana", slug: "home" }, { as: ana })]) {
      expect(page.status).toBe(200);
      expect(page.html).toContain("1 private workflow");
      expect(page.html).not.toMatch(/notes/i);
      // The map is the one someone signed out sees: the public member alone.
      expect(drawing(page.html)).toEqual(drawing(signedOut.html));
    }
  });
});

describe("every link in an embed", () => {
  it("opens a new tab, never the frame: a linked part, a part others use, a workflow's box on a map and the corner", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, twoPlaces);
    await pushed("acme", "dinners", { token: ana.token }, referring);
    await pushedSystem("acme", "kitchen", { token: ana.token }, { title: "The kitchen", members: ["acme/shopping", "acme/dinners"] });
    const pages = [
      await embedded(WorkflowEmbed, { owner: "acme", slug: "dinners" }),
      await embedded(WorkflowEmbed, { owner: "acme", slug: "shopping" }, { view: "platform" }),
      await embedded(VersionEmbed, { owner: "acme", slug: "dinners", n: "1" }),
      await embedded(SystemEmbed, { owner: "acme", slug: "kitchen" }),
    ];
    const hrefs = pages.flatMap((p) => links(p.html).map((l) => l.href));
    // The part with a ref, the part Dinners uses, and each workflow's box on the map.
    expect(hrefs).toEqual(expect.arrayContaining(["/acme/shopping#list", "/acme/dinners", "/acme/shopping"]));
    for (const page of pages) {
      expect(links(page.html).length).toBeGreaterThan(1);
      for (const link of links(page.html)) expect(link).toMatchObject({ target: "_blank", rel: "noopener" });
    }
  });

  it("opens a new tab from a part's menu of several workflows too", () => {
    const link = {
      part: "list",
      title: "Used by a/b and c/d",
      to: [
        { label: "a/b", href: "/a/b" },
        { label: "c/d", href: "/c/d" },
      ],
    };
    const html = renderToStaticMarkup(<PartMenu link={link} node={{ x: 0, y: 0, width: 10, height: 10 }} onClose={() => {}} newTab />);
    expect(links(html)).toEqual([
      { href: "/a/b", target: "_blank", rel: "noopener" },
      { href: "/c/d", target: "_blank", rel: "noopener" },
    ]);
    // On the site's own pages they open where they are.
    const own = renderToStaticMarkup(<PartMenu link={link} node={{ x: 0, y: 0, width: 10, height: 10 }} onClose={() => {}} />);
    expect(links(own).map((l) => l.target)).toEqual([undefined, undefined]);
  });
});

describe("an embed's drawing, laid out", () => {
  it("is the one the workflow's page shows, so both share the layouts each server keeps", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners);
    const { loadVersion } = await import("@/app/[owner]/[slug]/load");
    const { workflowEmbed } = await import("@/server/embed");
    pageRequest.headers = new Headers();
    const page = await loadVersion("acme", "dinners", "latest");
    const embed = await workflowEmbed("acme", "dinners", "latest", { view: "security", flow: false });
    expect(laidOut(embed!.drawing)).toEqual(laidOut(page.drawing));
  });
});
