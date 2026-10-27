// Parts linked to other workflows, marked in the drawing (issue #55). A part
// whose `ref` names another workflow's part carries a link mark in both views,
// and following it opens that workflow with the part in the fragment, which
// the page outlines once it is drawn. A part other workflows refer to carries
// the same mark, listing them. Neither names a workflow the viewer can't see.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadVersion } from "@/app/[owner]/[slug]/load";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { destination, partInHash } from "@/components/links";
import { PartMenu } from "@/components/PartLinks";
import { layOut } from "@/server/drawing";
import { partLinks, type PartLink } from "@/server/part-links";
import { orgWith, person, request, storeVersion, type Who } from "./helpers";
import { pageRequest } from "./pages";
import { laidOut } from "./drawn";

const shopping = `awml: "0.7"
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
      - { id: server, label: "Server", parts: [list, add] }
`;

// A workflow that keeps its own copy of a list another workflow has, and runs at home.
const referring = (ref: string, title = "Dinners") => `awml: "0.7"
title: ${title}
parts:
  - { id: list, kind: context, label: "Shopping list", ref: ${ref} }
  - { id: plan, kind: ai, label: "Plan the week's dinners" }
lines:
  - { from: list, to: plan, kind: data }
implementations:
  home:
    label: At home
    blocks:
      - { id: server, label: "Server", parts: [list, plan] }
`;

async function pushed(owner: string, slug: string, as: Who, workflow: string, visibility: "public" | "private" = "public") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow, visibility } });
  expect(res.status, await res.clone().text()).toBe(201);
}

// A workflow's page in a view, as someone: what it draws, and the links it gives the drawing.
async function pageOf(owner: string, slug: string, view: "security" | "platform", as?: { cookie: string }) {
  pageRequest.headers = new Headers();
  if (as) pageRequest.headers.set("cookie", as.cookie);
  const props = await loadVersion(owner, slug, "latest", view);
  expect(props.drawing).not.toBeNull();
  return props;
}

const linksOn = async (...args: Parameters<typeof pageOf>) => (await pageOf(...args)).links;

// Ana owns acme; Bea owns beta, with Mo as a member of both. Nell belongs to nothing.
async function world() {
  const ana = await person("ana");
  const bea = await person("bea");
  const mo = await person("mo");
  const nell = await person("nell");
  await orgWith("acme", ana, [mo]);
  await orgWith("beta", bea, [mo]);
  return { ana, bea, mo, nell };
}

describe("a part with a ref, marked in the drawing", () => {
  it("is marked with its address in both views, and links to the workflow with the part in the fragment", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    await pushed("acme", "dinners", { token: ana.token }, referring("acme/shopping#list"));
    const linked: PartLink[] = [
      { part: "list", title: "Linked to acme/shopping#list", to: [{ label: "acme/shopping", href: "/acme/shopping#list" }] },
    ];
    for (const view of ["security", "platform"] as const) {
      const page = await pageOf("acme", "dinners", view);
      // The drawing has the part, for the mark to go on.
      expect(laidOut(page.drawing).full.parts.map((p) => p.id)).toContain("list");
      expect(page.links).toEqual(linked);
    }
    expect(destination(linked[0])).toBe("/acme/shopping#list");
  });

  it("names a workflow not pushed yet to an owner or member of its owner, and to anyone else nothing", async () => {
    const { ana, bea, mo } = await world();
    const missing = [{ part: "list", title: "Linked to acme/lists#list, not pushed yet", to: [] }];
    // Ana owns acme.
    await pushed("acme", "plans", { token: ana.token }, referring("acme/lists#list"), "private");
    expect(await linksOn("acme", "plans", "security", ana)).toEqual(missing);
    // Mo is a member of acme, and of beta, whose workflow Bea, a member of beta alone, sees too.
    await pushed("beta", "plans", { token: bea.token }, referring("acme/lists#list"), "private");
    expect(await linksOn("beta", "plans", "security", mo)).toEqual(missing);
    expect(await linksOn("beta", "plans", "platform", mo)).toEqual(missing);
    expect(await linksOn("beta", "plans", "security", bea)).toEqual([
      { part: "list", title: "Linked to a workflow you can't see", to: [] },
    ]);
  });
});

describe("a part other workflows refer to", () => {
  it("lists its one referrer, and goes straight there", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    await pushed("acme", "dinners", { token: ana.token }, referring("acme/shopping#list"));
    const links = await linksOn("acme", "shopping", "security");
    expect(links).toEqual([{ part: "list", title: "Used by acme/dinners", to: [{ label: "acme/dinners", href: "/acme/dinners" }] }]);
    expect(destination(links[0])).toBe("/acme/dinners");
  });

  it("lists several referrers, and gives a menu of them", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    await pushed("acme", "dinners", { token: ana.token }, referring("acme/shopping#list"));
    await pushed("acme", "lunches", { token: ana.token }, referring("acme/shopping#list", "Lunches"));
    await pushed("acme", "parties", { token: ana.token }, referring("acme/shopping#list", "Parties"));
    const [link] = await linksOn("acme", "shopping", "security");
    expect(link.title).toBe("Used by acme/dinners, acme/lunches and acme/parties");
    expect(link.to.map((t) => t.href)).toEqual(["/acme/dinners", "/acme/lunches", "/acme/parties"]);
    expect(destination(link)).toBe("menu");
    const menu = renderToStaticMarkup(<PartMenu link={link} node={{ x: 10, y: 20, width: 120, height: 40 }} onClose={() => {}} />);
    expect(menu).toContain('role="menu"');
    // It is placed once it is drawn and its size is known, not where a guess of its size put it.
    expect(menu).not.toMatch(/style="[^"]*(left|top)/);
    expect(menu).toContain('aria-label="Used by acme/dinners, acme/lunches and acme/parties"');
    expect([...menu.matchAll(/<a [^>]*role="menuitem"[^>]*href="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]])).toEqual([
      ["/acme/dinners", "acme/dinners"],
      ["/acme/lunches", "acme/lunches"],
      ["/acme/parties", "acme/parties"],
    ]);
  });

  it("says both when a part refers and is referred to, and offers both", () => {
    const [link] = partLinks(
      [{ part: "list", state: "found", owner: "acme", slug: "shopping", id: "list" }],
      [{ owner: "acme", slug: "lunches", title: "Lunches", visibility: "public", parts: ["list"] }],
    );
    expect(link.title).toBe("Linked to acme/shopping#list\nUsed by acme/lunches");
    expect(destination(link)).toBe("menu");
  });
});

describe("an outside action that starts another workflow (AWML 0.7)", () => {
  const kinds = new Map([
    ["start", "outside"],
    ["low", "trigger"],
  ]);

  it("says it starts the workflow its ref names, or one the viewer can't see, or one not pushed yet", () => {
    expect(partLinks([{ part: "start", state: "found", owner: "acme", slug: "order", id: "low" }], [], kinds)).toEqual([
      { part: "start", title: "Starts acme/order#low", to: [{ label: "acme/order", href: "/acme/order#low" }] },
    ]);
    const hidden = partLinks([{ part: "start", state: "hidden" }], [], kinds);
    expect(hidden).toEqual([{ part: "start", title: "Starts a workflow you can't see", to: [] }]);
    expect(destination(hidden[0])).toBeNull();
    expect(partLinks([{ part: "start", state: "missing", owner: "acme", slug: "order", id: "low" }], [], kinds)).toEqual([
      { part: "start", title: "Starts acme/order#low, not pushed yet", to: [] },
    ]);
  });

  it("says a trigger is started by a referrer only when the referrer's part is an outside action", () => {
    const starter = { owner: "acme", slug: "stock", title: "Stock", visibility: "public" as const, parts: ["low"], starts: ["low"] };
    // A stored 0.6 workflow that shared the trigger by ref, from a trigger of its own, starts nothing.
    const sharer = { owner: "acme", slug: "old", title: "Old", visibility: "public" as const, parts: ["low"], starts: [] };
    expect(partLinks([], [starter], kinds)[0].title).toBe("Started by acme/stock");
    expect(partLinks([], [sharer], kinds)[0].title).toBe("Used by acme/old");
    expect(partLinks([], [starter, sharer], kinds)[0].title).toBe("Started by acme/stock\nUsed by acme/old");
  });
});

describe("parts linked across tenants", () => {
  it("names nothing and links nowhere for a ref to a private workflow the viewer may not see", async () => {
    const { ana, bea, mo } = await world();
    await pushed("acme", "secret", { token: ana.token }, shopping, "private");
    await pushed("beta", "plans", { token: bea.token }, referring("acme/secret#list"), "private");
    const hidden = [{ part: "list", title: "Linked to a workflow you can't see", to: [] }];
    expect(await linksOn("beta", "plans", "security", bea)).toEqual(hidden);
    expect(await linksOn("beta", "plans", "platform", bea)).toEqual(hidden);
    expect(destination(hidden[0])).toBeNull();
    // Mo belongs to both, and may follow it.
    expect(await linksOn("beta", "plans", "security", mo)).toEqual([
      { part: "list", title: "Linked to acme/secret#list", to: [{ label: "acme/secret", href: "/acme/secret#list" }] },
    ]);
  });

  it("never lists a private referrer to anyone who may not see it", async () => {
    const { ana, bea, nell } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    await pushed("beta", "plans", { token: bea.token }, referring("acme/shopping#list"), "private");
    await pushed("acme", "dinners", { token: ana.token }, referring("acme/shopping#list"));
    const shown = [{ part: "list", title: "Used by acme/dinners", to: [{ label: "acme/dinners", href: "/acme/dinners" }] }];
    expect(await linksOn("acme", "shopping", "security")).toEqual(shown);
    expect(await linksOn("acme", "shopping", "security", nell)).toEqual(shown);
    expect(await linksOn("acme", "shopping", "platform", ana)).toEqual(shown);
    expect((await linksOn("acme", "shopping", "security", bea))[0].title).toBe("Used by acme/dinners and beta/plans");
  });

  it("names nothing and links nowhere for someone signed out or a stranger, on a public workflow whose ref they can't see", async () => {
    const { ana, bea, nell } = await world();
    await pushed("acme", "secret", { token: ana.token }, shopping, "private");
    // A push refuses a public workflow that refers to a private one, so this one is written
    // straight to the database: whatever is stored, the drawing names nothing they can't see.
    await storeVersion("beta", "plans", bea, { workflow: referring("acme/secret#list") }, { visibility: "public" });
    const hidden = [{ part: "list", title: "Linked to a workflow you can't see", to: [] }];
    for (const who of [undefined, nell])
      for (const view of ["security", "platform"] as const) {
        const page = await pageOf("beta", "plans", view, who);
        expect(page.links).toEqual(hidden);
        expect(JSON.stringify(page.links)).not.toContain("acme");
        expect(laidOut(page.drawing).full.parts.map((p) => p.id)).toContain("list");
      }
    expect(destination(hidden[0])).toBeNull();
  });

  it("leads a part with a ref the viewer can't see only to the referrer they can", async () => {
    const { ana, bea } = await world();
    await pushed("acme", "secret", { token: ana.token }, shopping, "private");
    await pushed("beta", "plans", { token: bea.token }, referring("acme/secret#list"), "private");
    await pushed("beta", "lunches", { token: bea.token }, referring("beta/plans#list", "Lunches"), "private");
    const [link] = await linksOn("beta", "plans", "security", bea);
    expect(link).toEqual({
      part: "list",
      title: "Linked to a workflow you can't see\nUsed by beta/lunches",
      to: [{ label: "beta/lunches", href: "/beta/lunches" }],
    });
    expect(destination(link)).toBe("/beta/lunches");
  });

  it("marks nothing on a workflow with no refs either way", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    expect(await linksOn("acme", "shopping", "security")).toEqual([]);
  });
});

// A drawing of a workflow whose list is linked, laid out as the server lays it out.
async function drawn() {
  const graph = JSON.stringify({
    view: "security",
    groups: [],
    parts: [
      { id: "list", kind: "context", label: "Shopping list" },
      { id: "plan", kind: "ai", label: "Plan the week's dinners", decider: "ai" },
    ],
    lines: [{ from: "list", to: "plan", kind: "data", points: "to" }],
    comments: [],
    places: [],
  });
  return laidOut(await layOut(graph)).full;
}

// The SVG the server sends for a drawing, with the links given.
const svgOf = async (links: PartLink[]) => renderToStaticMarkup(<StaticDrawing drawing={await drawn()} id="t" links={links} />);
// A part's piece of that SVG.
const partIn = (svg: string, part: string) => new RegExp(`<g transform="[^"]+" data-part="${part}">[^]*?</g></g>`).exec(svg)?.[0] ?? "";

describe("marking a linked part in the drawing", () => {
  it("marks a part it may follow with a link to its workflow, named by the part and where it leads", async () => {
    const svg = await svgOf([{ part: "list", title: "Linked to acme/shopping#list", to: [{ label: "acme/shopping", href: "/acme/shopping#list" }] }]);
    const list = partIn(svg, "list");
    expect(list).toContain("<title>Linked to acme/shopping#list</title>");
    expect(list).toContain('<a href="/acme/shopping#list" aria-label="Shopping list. Linked to acme/shopping#list">');
    // The chain mark in its top-right corner, its circle (radius 9, half of a 2px stroke)
    // inside the part's box, so a part at the drawing's edge doesn't lose it.
    const { width } = (await drawn()).parts.find((p) => p.id === "list")!;
    expect(list).toContain(`<g class="part-link-mark" transform="translate(${width - 10}, 10)" aria-hidden="true"><circle r="9">`);
    // The part without a link has no mark.
    expect(partIn(svg, "plan")).not.toContain("part-link-mark");
  });

  it("marks a part with several places to go, whose menu the page opens, with no link of its own", async () => {
    const svg = await svgOf([
      {
        part: "list",
        title: "Used by a/b and c/d",
        to: [
          { label: "a/b", href: "/a/b" },
          { label: "c/d", href: "/c/d" },
        ],
      },
    ]);
    const list = partIn(svg, "list");
    expect(list).toContain("<title>Used by a/b and c/d</title>");
    expect(list).toContain('class="part-link-mark"');
    expect(list).not.toContain("<a ");
  });

  it("marks a part it may not follow, with no link", async () => {
    const svg = await svgOf([{ part: "list", title: "Linked to a workflow you can't see", to: [] }]);
    const list = partIn(svg, "list");
    expect(list).toContain("<title>Linked to a workflow you can&#x27;t see</title>");
    expect(list).toContain('class="part-link-mark off"');
    expect(list).not.toContain("<a ");
  });
});

describe("the page a link opens", () => {
  it("reads the part from the fragment", () => {
    expect(partInHash("#token")).toBe("token");
    expect(partInHash("#parents_chat")).toBe("parents_chat");
    expect(partInHash("")).toBeNull();
    expect(partInHash("#")).toBeNull();
    expect(partInHash("#change")).toBe("change");
    expect(partInHash("#not a part")).toBeNull();
  });

});
