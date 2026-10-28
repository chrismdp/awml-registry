// The pages that show a drawing, given one the server couldn't lay out (src/server/drawing.ts):
// a workflow's page, the gallery's card and a system's map each say so in place of the drawing,
// and none answers 500. And the labels whose line breaks once took a page down draw.
import ELK from "elkjs/lib/elk.bundled.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@/engine";
import { LIMITS } from "@/server/drawing";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import GalleryPage from "@/app/gallery/page";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import { drawing, expected } from "./drawn";
import { example, person, request, type Who } from "./helpers";
import { renderPage } from "./pages";

afterEach(() => {
  vi.restoreAllMocks();
});

async function push(owner: string, slug: string, as: Who, file: string) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow: file, visibility: "public" } });
  expect(res.status, await res.clone().text()).toBe(201);
}

// A workflow of n steps, one after another, each labelled with `words`.
const steps = (title: string, words: string, n: number) => `awml: "0.8"
title: ${title}
scopes:
  - { id: home, label: "home: the family" }
parts:
  - { id: tick, kind: trigger, label: "Every morning", in: home }
${Array.from({ length: n }, (_, i) => `  - { id: s${i}, kind: code, op: do, label: "${words} ${i}", in: home }`).join("\n")}
lines:
  - { from: tick, to: s0, kind: start }
${Array.from({ length: n - 1 }, (_, i) => `  - { from: s${i}, to: s${i + 1}, kind: start }`).join("\n")}
`;

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("a workflow whose labels break lines", () => {
  it("is drawn on its page and its gallery card, every part with its label", async () => {
    const ana = await person("ana");
    for (const [slug, name] of [
      ["folded", "label-folded.yaml"],
      ["ends", "label-end.yaml"],
    ]) {
      const file = example(name);
      await push(ana.username, slug, { token: ana.token }, file);
      const page = await renderPage(WorkflowPage, { owner: ana.username, slug });
      expect(page.status).toBe(200);
      expect(drawing(page.html)).toEqual(expected(file));
    }
    const gallery = await renderPage(GalleryPage, {});
    expect(gallery.status).toBe(200);
    expect(gallery.html.match(/<svg class="flow-static"/g)).toHaveLength(2);
  });
});

describe("a workflow too big to draw", () => {
  it("says so on its page, and its gallery card has no drawing", async () => {
    const ana = await person("ana");
    const big = steps("A long day", "Step", LIMITS.parts);
    expect(await engine.check(big)).toEqual([]);
    await push(ana.username, "long-day", { token: ana.token }, big);
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "long-day" });
    expect(page.status).toBe(200);
    expect(words(page.html)).toContain("This workflow is too big to draw here.");
    expect(page.html).not.toContain("flow-frame");
    const gallery = await renderPage(GalleryPage, {});
    expect(gallery.status).toBe(200);
    expect(words(gallery.html)).toContain("A long day");
    expect(drawing(gallery.html)).toBeNull();
  });
});

describe("a drawing whose layout fails", () => {
  it("says so on the workflow's page and its system's map, never giving ELK's error, and leaves the gallery card undrawn", async () => {
    const ana = await person("ana");
    await push(ana.username, "fails", { token: ana.token }, steps("It fails", "Fails at", 3));
    await push(ana.username, "fails-too", { token: ana.token }, steps("It fails too", "Fails too at", 2));
    const sys = await request("POST", `/api/v1/${ana.username}/systems/failing/versions`, {
      as: { token: ana.token },
      json: { title: "Failing", members: [`${ana.username}/fails`, `${ana.username}/fails-too`], visibility: "public" },
    });
    expect(sys.status, await sys.clone().text()).toBe(201);
    vi.spyOn(ELK.prototype, "layout").mockRejectedValue(new Error("org.eclipse.elk.core.UnsupportedGraphException: Referenced shape does not exist"));

    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "fails" });
    expect(page.status).toBe(200);
    expect(words(page.html)).toContain("This workflow can't be drawn here.");
    const map = await renderPage(SystemPage, { owner: ana.username, slug: "failing" });
    expect(map.status).toBe(200);
    expect(words(map.html)).toContain("This map can't be drawn here.");
    for (const html of [page.html, map.html]) expect(html).not.toMatch(/eclipse|Exception|shape does not exist/);
    const gallery = await renderPage(GalleryPage, {});
    expect(gallery.status).toBe(200);
    expect(drawing(gallery.html)).toBeNull();
  });
});
