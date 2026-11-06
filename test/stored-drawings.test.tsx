// Drawings laid out on push and stored (issue #131): a push lays its version's drawings out once
// it has answered and stores them in the database, a page reads the stored drawing for its graph
// and lays one out only when none is stored under this layout, and the gallery never lays out.
import ELK from "elkjs/lib/elk.bundled.js";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawings, Undrawn } from "@/components/flow/drawing";
import { getDb } from "@/db/client";
import { drawing as stored } from "@/db/schema";
import { engine } from "@/engine";
import { LAYOUT_VERSION, LIMITS, layOut } from "@/server/drawing";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import GalleryPage from "@/app/gallery/page";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import { drawing, expected, laidOut } from "./drawn";
import { person, request, settle, storeVersion, type Who } from "./helpers";
import { renderPage } from "./pages";

afterEach(() => {
  vi.restoreAllMocks();
});

async function push(owner: string, slug: string, as: Who, file: string) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow: file, visibility: "public" } });
  expect(res.status, await res.clone().text()).toBe(201);
}

// A workflow of n steps, one after another, each labelled with `words`. Each test draws its own
// words, so no layout another test made, and this server keeps, is found for it.
const steps = (title: string, words: string, n: number) => `awml: "0.11"
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

// The SHA-256 of a graph's JSON, as a stored drawing is found by.
async function keyOf(json: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Every drawing stored for a graph, under any layout.
async function storedFor(json: string) {
  const db = await getDb();
  return db.select().from(stored).where(eq(stored.graph, await keyOf(json)));
}

// A drawing stored by hand for a graph, under `layout`, its first part's label changed to
// `label`, so a page that shows it can only have read it from the database.
async function storeChanged(json: string, layout: string, label: string) {
  const db = await getDb();
  const drawn = laidOut(await layOut(json));
  drawn.full.parts[0].lines = [label];
  await db.insert(stored).values({ graph: await keyOf(json), layout, drawn });
}

describe("a push", () => {
  it("stores its version's drawings once it has answered, so its page lays nothing out", async () => {
    const ana = await person("ana");
    const file = steps("Pushed and stored", "Pushed", 3);
    await push(ana.username, "pushed", { token: ana.token }, file);
    const graph = await engine.graph(file);
    expect(await storedFor(graph)).toEqual([]);
    await settle();
    const [row] = await storedFor(graph);
    expect(row.layout).toBe(LAYOUT_VERSION);
    const drawn = row.drawn as Drawings;
    expect(Object.keys(drawn).sort()).toEqual(["flow", "full"]);

    const layout = vi.spyOn(ELK.prototype, "layout");
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "pushed" });
    expect(page.status).toBe(200);
    expect(drawing(page.html)).toEqual(expected(file));
    expect(layout).not.toHaveBeenCalled();
  });

  it("stores the drawings with descriptions open too, when a part has a description", async () => {
    const ana = await person("ana");
    const file = steps("Described", "Described", 2).replace(
      'label: "Described 0", in: home',
      'label: "Described 0", description: "What it does, at length.", in: home',
    );
    await push(ana.username, "described", { token: ana.token }, file);
    await settle();
    const [row] = await storedFor(await engine.graph(file));
    expect(Object.keys(row.drawn).sort()).toEqual(["flow", "full", "open"]);
  });

  it("still succeeds when its drawing is too big to lay out, and its page says why", async () => {
    const ana = await person("ana");
    const big = steps("Too big to store", "Big", LIMITS.parts);
    await push(ana.username, "big", { token: ana.token }, big);
    await settle();
    expect((await storedFor(await engine.graph(big))).map((r) => r.drawn)).toEqual([{ undrawn: "too big" }]);
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "big" });
    expect(words(page.html)).toContain("This workflow is too big to draw here.");
  });

  it("still succeeds when its layout fails, and its page says why, never ELK's error", async () => {
    const ana = await person("ana");
    vi.spyOn(ELK.prototype, "layout").mockRejectedValue(new Error("org.eclipse.elk.core.UnsupportedGraphException: Referenced shape does not exist"));
    const file = steps("Fails to store", "Unstored", 2);
    await push(ana.username, "unstored", { token: ana.token }, file);
    await settle();
    expect((await storedFor(await engine.graph(file))).map((r) => r.drawn)).toEqual([{ undrawn: "failed" }]);
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "unstored" });
    expect(page.status).toBe(200);
    expect(words(page.html)).toContain("This workflow can't be drawn here.");
    expect(page.html).not.toMatch(/eclipse|Exception|shape does not exist/);
  });

  it("of a system stores its map", async () => {
    const ana = await person("ana");
    await push(ana.username, "mapped-a", { token: ana.token }, steps("Mapped A", "Mapped A", 2));
    await push(ana.username, "mapped-b", { token: ana.token }, steps("Mapped B", "Mapped B", 2));
    await settle();
    const before = (await (await getDb()).select().from(stored)).length;
    const res = await request("POST", `/api/v1/${ana.username}/systems/mapped/versions`, {
      as: { token: ana.token },
      json: { title: "Mapped", members: [`${ana.username}/mapped-a`, `${ana.username}/mapped-b`], visibility: "public" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    await settle();
    const map = await engine.graphMap([
      { file: `${ana.username}/mapped-a.yaml`, source: steps("Mapped A", "Mapped A", 2) },
      { file: `${ana.username}/mapped-b.yaml`, source: steps("Mapped B", "Mapped B", 2) },
    ]);
    const [row] = await storedFor(map);
    expect(row.layout).toBe(LAYOUT_VERSION);
    expect("full" in row.drawn).toBe(true);
    expect((await (await getDb()).select().from(stored)).length).toBe(before + 1);

    const layout = vi.spyOn(ELK.prototype, "layout");
    const page = await renderPage(SystemPage, { owner: ana.username, slug: "mapped" });
    expect(page.status).toBe(200);
    expect(page.html).toContain('class="flow-static"');
    expect(layout).not.toHaveBeenCalled();
  });
});

describe("a page whose drawing isn't stored", () => {
  it("lays it out once, stores it, and the next view reads the stored one", async () => {
    const ana = await person("ana");
    const file = steps("Stored on view", "Viewed", 3);
    await storeVersion(ana.username, "viewed", ana, { workflow: file });
    const graph = await engine.graph(file);
    const layout = vi.spyOn(ELK.prototype, "layout");
    const first = await renderPage(WorkflowPage, { owner: ana.username, slug: "viewed" });
    expect(drawing(first.html)).toEqual(expected(file));
    expect(layout).toHaveBeenCalledTimes(2);
    const [row] = await storedFor(graph);
    expect(row.layout).toBe(LAYOUT_VERSION);
    layout.mockClear();
    const second = await renderPage(WorkflowPage, { owner: ana.username, slug: "viewed" });
    expect(drawing(second.html)).toEqual(expected(file));
    expect(layout).not.toHaveBeenCalled();
  });

  it("shows the drawing stored for its graph, read from the database", async () => {
    const ana = await person("ana");
    const file = steps("Read from the database", "Read", 2);
    await storeVersion(ana.username, "read", ana, { workflow: file });
    await storeChanged(await engine.graph(file), LAYOUT_VERSION, "Read from the store");
    const layout = vi.spyOn(ELK.prototype, "layout");
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "read" });
    expect(words(page.html)).toContain("Read from the store");
    expect(layout).not.toHaveBeenCalled();
  });

  it("lays out again a drawing stored under another layout, and replaces it", async () => {
    const ana = await person("ana");
    const file = steps("Stale on view", "Stale", 2);
    await storeVersion(ana.username, "stale", ana, { workflow: file });
    const graph = await engine.graph(file);
    await storeChanged(graph, "v0.0.0+layout.0", "Laid out by an older layout");
    const layout = vi.spyOn(ELK.prototype, "layout");
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "stale" });
    expect(drawing(page.html)).toEqual(expected(file));
    expect(words(page.html)).not.toContain("Laid out by an older layout");
    expect(layout).toHaveBeenCalled();
    expect((await storedFor(graph)).map((r) => r.layout)).toEqual([LAYOUT_VERSION]);
  });
});

describe("the gallery", () => {
  it("lays nothing out: a card shows its stored drawing, and one with none shows none until it is stored", async () => {
    const ana = await person("ana");
    const shown = steps("Shown in the gallery", "Shown", 2);
    const later = steps("Drawn later", "Later", 2);
    await storeVersion(ana.username, "shown", ana, { workflow: shown });
    await storeVersion(ana.username, "later", ana, { workflow: later });
    await storeChanged(await engine.graph(shown), LAYOUT_VERSION, "Read from the store");
    const layout = vi.spyOn(ELK.prototype, "layout");

    const gallery = await renderPage(GalleryPage, {});
    expect(gallery.status).toBe(200);
    expect(gallery.html.match(/<svg class="flow-static"/g)).toHaveLength(1);
    expect(words(gallery.html)).toContain("Read from the store");
    expect(words(gallery.html)).toContain("Drawn later");
    expect(layout).not.toHaveBeenCalled();
    expect(await storedFor(await engine.graph(later))).toEqual([]);

    // Laid out once the gallery has answered, and stored, so the card shows it next time.
    await settle();
    const [row] = await storedFor(await engine.graph(later));
    expect(row.layout).toBe(LAYOUT_VERSION);
    layout.mockClear();
    const next = await renderPage(GalleryPage, {});
    expect(next.html.match(/<svg class="flow-static"/g)).toHaveLength(2);
    expect(layout).not.toHaveBeenCalled();
  });

  it("shows no drawing for a card stored as too big", async () => {
    const ana = await person("ana");
    const big = steps("Too big for a card", "Card", LIMITS.parts);
    await push(ana.username, "card", { token: ana.token }, big);
    await settle();
    const gallery = await renderPage(GalleryPage, {});
    expect(words(gallery.html)).toContain("Too big for a card");
    expect(drawing(gallery.html)).toBeNull();
    expect(((await storedFor(await engine.graph(big)))[0].drawn as Undrawn).undrawn).toBe("too big");
  });
});
