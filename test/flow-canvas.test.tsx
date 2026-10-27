// The drawing's nodes once React Flow has taken over from the server's SVG
// (src/components/flow/FlowCanvas.tsx), as React Flow renders them: a linked part (#55) is a
// focusable link or a menu button named by where it leads, with its tooltip, a part it may not
// follow is still named, the part the address names is outlined, and a workflow's box on a
// system's map (#61) is a link to its page.
import { ReactFlow } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { layeredNodes, NODE_TYPES } from "@/components/flow/FlowCanvas";
import { layOut } from "@/server/drawing";
import type { PartLink } from "@/server/part-links";
import { laidOut } from "./drawn";
import { example } from "./helpers";

const text = `flowchart TB\n  list[("Shopping list")]\n  plan("<small>🤖</small><br>Plan the week#39;s dinners")\n  list -.-> plan\n  n@{ shape: notch-rect, label: "Kept by Ana" }\n  class list ctx\n  class plan ai\n  class n gap`;

// The nodes React Flow draws for a drawing, as it renders them.
async function rendered(
  source: string,
  { links = [], hrefs = {}, target, menuFor }: { links?: PartLink[]; hrefs?: Record<string, string>; target?: string; menuFor?: string },
) {
  const { full } = laidOut(await layOut(source, { map: Object.keys(hrefs).length > 0 }));
  const nodes = layeredNodes(full, { id: "t", links: new Map(links.map((l) => [l.part, l])), hrefs, notes: new Map(), target, menuFor, onNote: () => {} });
  return renderToStaticMarkup(<ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} width={800} height={600} />);
}

// A node's opening tag, and all it holds up to the next node.
const node = (html: string, id: string) => {
  const at = html.indexOf(`data-id="${id}"`);
  if (at < 0) return { tag: "", inside: "" };
  const start = html.lastIndexOf("<div", at);
  const end = html.indexOf('<div class="react-flow__node ', at);
  return { tag: html.slice(start, html.indexOf(">", at) + 1), inside: html.slice(start, end < 0 ? undefined : end) };
};

const one: PartLink = { part: "list", title: "Linked to acme/shopping#list", to: [{ label: "acme/shopping", href: "/acme/shopping#list" }] };
const several: PartLink = {
  part: "list",
  title: "Used by a/b and c/d",
  to: [
    { label: "a/b", href: "/a/b" },
    { label: "c/d", href: "/c/d" },
  ],
};

describe("a linked part, once React Flow draws it", () => {
  it("is a focusable link named by the part and where it leads, with its tooltip", async () => {
    const list = node(await rendered(text, { links: [one] }), "list");
    expect(list.tag).toContain('tabindex="0"');
    expect(list.tag).toContain('role="link"');
    expect(list.tag).toContain('aria-label="Shopping list. Linked to acme/shopping#list"');
    expect(list.inside).toContain("<title>Linked to acme/shopping#list</title>");
    expect(list.inside).toContain('class="part-link-mark"');
  });

  it("is a button with several places to go, saying whether its menu is open", async () => {
    const shut = node(await rendered(text, { links: [several] }), "list");
    expect(shut.tag).toContain('tabindex="0"');
    expect(shut.tag).toContain('role="button"');
    expect(shut.tag).toContain('aria-haspopup="menu"');
    expect(shut.tag).toContain('aria-expanded="false"');
    expect(shut.tag).toContain('aria-label="Shopping list. Used by a/b and c/d"');
    expect(shut.inside).toContain("<title>Used by a/b and c/d</title>");
    const open = node(await rendered(text, { links: [several], menuFor: "list" }), "list");
    expect(open.tag).toContain('aria-expanded="true"');
  });

  it("is named, with its tooltip, though it leads nowhere the viewer may go, and takes no focus", async () => {
    const list = node(await rendered(text, { links: [{ part: "list", title: "Linked to a workflow you can't see", to: [] }] }), "list");
    expect(list.tag).not.toContain("tabindex");
    expect(list.tag).toContain("aria-label=\"Shopping list. Linked to a workflow you can&#x27;t see\"");
    expect(list.inside).toContain("<title>Linked to a workflow you can&#x27;t see</title>");
    expect(list.inside).toContain('class="part-link-mark off"');
  });

  it("is outlined when the address names it, and no other part is", async () => {
    const html = await rendered(text, { links: [one], target: "plan" });
    expect(node(html, "plan").inside).toContain('class="flow-node part-target"');
    expect(node(html, "list").inside).not.toContain("part-target");
  });

  it("is left alone, unfocusable and unnamed, when nothing links it", async () => {
    const plan = node(await rendered(text, {}), "plan");
    expect(plan.tag).not.toContain("tabindex");
    expect(plan.tag).not.toContain("aria-label");
    expect(plan.inside).not.toContain("<title>");
  });
});

describe("a workflow's box on a system's map, once React Flow draws it", () => {
  it("is a focusable link to the workflow's page, named by it", async () => {
    const html = await rendered(example("flow/factory-map.mmd"), { hrefs: { w1: "/chrismdp/issue-to-pull-request" } });
    const w1 = node(html, "w1");
    expect(w1.tag).toContain('tabindex="0"');
    expect(w1.tag).toContain('role="link"');
    expect(w1.tag).toContain('aria-label="Open An issue becomes a pull request"');
    // A box the viewer may not open is no link.
    expect(node(html, "w2").tag).not.toContain('role="link"');
  });
});

describe("the notes of the whole drawing, once React Flow draws it", () => {
  it("have one icon of their own, a button that opens them", async () => {
    const html = await rendered(text, {});
    const notes = node(html, "notes-of-the-drawing");
    expect(notes.inside).toContain('class="flow-note-mark nodrag nopan"');
    expect(notes.inside).toContain('aria-label="Note on The whole drawing"');
    // It is no part of its own, for a reader to tab to apart from its button.
    expect(notes.tag).not.toContain("tabindex");
  });
});
