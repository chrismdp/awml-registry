// Parts linked to other workflows, marked in the drawing (issue #55). A part
// whose `ref` names another workflow's part carries a link mark in both views,
// and following it opens that workflow with the part in the fragment, which
// the page outlines once it is drawn. A part other workflows refer to carries
// the same mark, listing them. Neither names a workflow the viewer can't see.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadVersion } from "@/app/[owner]/[slug]/load";
import {
  destination,
  findPart,
  markPart,
  outlinePart,
  partInHash,
  partLinks,
  PartMenu,
  type PartLink,
} from "@/components/part-links";
import { orgWith, person, request, type Who } from "./helpers";
import { pageRequest } from "./pages";

const shopping = `awml: "0.6"
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
const referring = (ref: string, title = "Dinners") => `awml: "0.6"
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

// The links a workflow's page gives its drawing, in a view, as someone.
async function linksOn(owner: string, slug: string, view: "security" | "platform", as?: { cookie: string }) {
  pageRequest.headers = new Headers();
  if (as) pageRequest.headers.set("cookie", as.cookie);
  const props = await loadVersion(owner, slug, "latest", view);
  expect(props.mermaid).not.toBe("");
  return props.links;
}

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
    expect(await linksOn("acme", "dinners", "security")).toEqual(linked);
    expect(await linksOn("acme", "dinners", "platform")).toEqual(linked);
    expect(destination(linked[0])).toBe("/acme/shopping#list");
  });

  it("names a workflow not pushed yet to someone who may see its owner, without linking to it", () => {
    expect(partLinks([{ part: "list", state: "missing", owner: "acme", slug: "lists", id: "list" }], [])).toEqual([
      { part: "list", title: "Linked to acme/lists#list, not pushed yet", to: [] },
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
    const menu = renderToStaticMarkup(<PartMenu link={link} at={{ x: 10, y: 20 }} onClose={() => {}} />);
    expect(menu).toContain('role="menu"');
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

  it("marks nothing on a workflow with no refs either way", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping);
    expect(await linksOn("acme", "shopping", "security")).toEqual([]);
  });
});

// Just enough of an SVG document for marking a drawn node: Mermaid draws a
// part as <g class="node" id="{drawing}-flowchart-{part}-{n}">.
class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  classes = new Set<string>();
  textContent = "";
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(
    public tagName: string,
    public ownerDocument: FakeDocument,
    public id = "",
  ) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  getBBox() {
    return { x: -50, y: -20, width: 100, height: 40 };
  }
  querySelectorAll(selector: string) {
    const all: FakeElement[] = [];
    const walk = (e: FakeElement) => e.children.forEach((c) => (all.push(c), walk(c)));
    walk(this);
    if (selector === "g.node") return all.filter((e) => e.tagName === "g" && e.classes.has("node"));
    if (selector === ".part-target") return all.filter((e) => e.classes.has("part-target"));
    throw new Error(`no fake for ${selector}`);
  }
}
class FakeDocument {
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag, this);
  }
}

function drawing() {
  const doc = new FakeDocument();
  const root = new FakeElement("div", doc);
  for (const [id, cls] of [
    ["m1-flowchart-list-0", "node"],
    ["m1-flowchart-list_old-1", "node"],
    ["m1-flowchart-plan-2", "node"],
    ["list", "cluster"],
  ]) {
    const g = new FakeElement("g", doc, id);
    g.classList.add(cls);
    root.appendChild(g);
  }
  return root as unknown as HTMLElement;
}

describe("finding and marking a part in the drawing", () => {
  it("finds a part's node by its id, and only that part's", () => {
    const root = drawing();
    expect(findPart(root, "list")?.id).toBe("m1-flowchart-list-0");
    expect(findPart(root, "plan")?.id).toBe("m1-flowchart-plan-2");
    expect(findPart(root, "lis")).toBeNull();
    expect(findPart(root, "missing")).toBeNull();
  });

  it("marks a node it may follow as a focusable link with its tooltip", () => {
    const node = findPart(drawing(), "list")! as unknown as FakeElement;
    markPart(node as unknown as SVGGElement, {
      part: "list",
      title: "Linked to acme/shopping#list",
      to: [{ label: "acme/shopping", href: "/acme/shopping#list" }],
    });
    expect(node.getAttribute("data-part-link")).toBe("list");
    expect(node.getAttribute("tabindex")).toBe("0");
    expect(node.getAttribute("role")).toBe("link");
    expect(node.getAttribute("aria-label")).toBe("Linked to acme/shopping#list");
    expect(node.classes.has("part-linked")).toBe(true);
    expect(node.children[0].tagName).toBe("title");
    expect(node.children[0].textContent).toBe("Linked to acme/shopping#list");
    const mark = node.children.at(-1)!;
    expect(mark.classes.has("part-link-mark")).toBe(true);
    expect(mark.getAttribute("transform")).toBe("translate(50, -20)");
  });

  it("marks a node with several places to go as a button that opens a menu", () => {
    const node = findPart(drawing(), "list")! as unknown as FakeElement;
    markPart(node as unknown as SVGGElement, {
      part: "list",
      title: "Used by a/b and c/d",
      to: [
        { label: "a/b", href: "/a/b" },
        { label: "c/d", href: "/c/d" },
      ],
    });
    expect(node.getAttribute("role")).toBe("button");
    expect(node.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("marks a node it may not follow, with no link and no focus", () => {
    const node = findPart(drawing(), "list")! as unknown as FakeElement;
    markPart(node as unknown as SVGGElement, { part: "list", title: "Linked to a workflow you can't see", to: [] });
    expect(node.getAttribute("tabindex")).toBeNull();
    expect(node.getAttribute("role")).toBeNull();
    expect(node.getAttribute("data-part-link")).toBeNull();
    expect(node.classes.has("part-linked")).toBe(true);
    expect(node.classes.has("part-link-off")).toBe(true);
    expect(node.children[0].textContent).toBe("Linked to a workflow you can't see");
    expect(node.children.at(-1)!.classes.has("part-link-mark")).toBe(true);
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

  it("outlines the part the fragment names, and only it", () => {
    const root = drawing();
    expect(outlinePart(root, "#plan")?.id).toBe("m1-flowchart-plan-2");
    const plan = findPart(root, "plan") as unknown as FakeElement;
    expect(plan.classes.has("part-target")).toBe(true);
    expect(outlinePart(root, "#list")?.id).toBe("m1-flowchart-list-0");
    expect(plan.classes.has("part-target")).toBe(false);
    expect((findPart(root, "list") as unknown as FakeElement).classes.has("part-target")).toBe(true);
    expect(outlinePart(root, "#nothing")).toBeNull();
    expect((findPart(root, "list") as unknown as FakeElement).classes.has("part-target")).toBe(false);
  });
});
