// Moving between a workflow page's tabs (issue #54): a tab is a client
// navigation, so Mermaid stays loaded; a tab draws only what it shows; the
// engine works out each answer once for the same files; and a diagram tab
// never shows Mermaid's text before its drawing, unless Mermaid can't draw it.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@/engine";
import { memoise } from "@/engine/memo";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import ImplementationPage from "@/app/[owner]/[slug]/platform/[implementation]/page";
import { example, person, request } from "./helpers";
import { renderPage } from "./pages";

// Next's Link, standing in as the plain link it renders, saying how it was
// asked to navigate: data-link for a client navigation, data-scroll for its
// scroll, and data-prefetch only when the link asks for other than Next's
// default prefetch.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, scroll, prefetch, ...rest }: { href: string; scroll?: boolean; prefetch?: boolean | null }) =>
      createElement("a", {
        ...rest,
        href,
        "data-link": "",
        "data-scroll": String(scroll ?? true),
        ...(prefetch === undefined ? {} : { "data-prefetch": String(prefetch) }),
      }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const dinners = example("dinners.yaml");
// The family's dinners with a second implementation, so the platform view
// offers a choice of the two.
const twoPlaces = `${dinners.trimEnd()}
  away:
    label: Away for the summer
    blocks:
      - { id: cloud, label: "A cloud server", parts: [${[...dinners.matchAll(/parts: \[([^\]]*)\]/g)].map((m) => m[1]).join(", ")}] }
`;

async function pushed(workflow = dinners) {
  const ana = await person("ana");
  const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
    as: { token: ana.token },
    json: { workflow },
  });
  expect(res.status).toBe(201);
  return ana.username;
}

// The opening tag of each tab, and of each choice of implementation.
const tabLinks = (html: string) => [...html.matchAll(/<a [^>]*\brole="tab"[^>]*>/g)].map(([tag]) => tag);
const implementationLinks = (html: string) =>
  [...html.matchAll(/<a [^>]*\bclass="implementation"[^>]*>/g)].map(([tag]) => tag);

describe("a workflow page's tabs", () => {
  it("moves between the tabs and the implementations by client navigation, keeping the scroll position", async () => {
    const owner = await pushed(twoPlaces);
    const params = { owner, slug: "dinners" };
    const pages = [WorkflowPage, WorkflowPlatformPage, WorkflowYamlPage, WorkflowChecksPage];
    const shown = [];
    for (const page of pages) shown.push((await renderPage(page, params)).html);
    shown.push((await renderPage(ImplementationPage, { ...params, implementation: "away" })).html);
    for (const html of shown) {
      expect(tabLinks(html)).toHaveLength(4);
      for (const tag of tabLinks(html)) {
        expect(tag).toContain('data-link=""');
        expect(tag).toContain('data-scroll="false"');
        // Next's default prefetch: with no loading.tsx and no partial
        // prerendering, it fetches only the route's tree, so no tab is
        // rendered for the viewer before they click it.
        expect(tag).not.toContain("data-prefetch");
      }
    }
    const choices = [shown[1], shown[4]].flatMap(implementationLinks);
    expect(choices).toHaveLength(4);
    for (const tag of choices) {
      expect(tag).toContain('data-link=""');
      expect(tag).toContain('data-scroll="false"');
      expect(tag).not.toContain("data-prefetch");
    }
  });

  it("draws only on the tabs that show a drawing", async () => {
    const owner = await pushed();
    const draw = vi.spyOn(engine, "draw");
    for (const page of [WorkflowYamlPage, WorkflowChecksPage]) {
      expect((await renderPage(page, { owner, slug: "dinners" })).status).toBe(200);
    }
    expect(draw).not.toHaveBeenCalled();
    for (const page of [WorkflowPage, WorkflowPlatformPage]) {
      expect((await renderPage(page, { owner, slug: "dinners" })).status).toBe(200);
    }
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("starts the engine before reading the database, so its first start overlaps the reads", async () => {
    const owner = await pushed();
    const order: string[] = [];
    vi.spyOn(engine, "start").mockImplementation(async () => {
      order.push("start");
    });
    const { getDb } = await import("@/db/client");
    const db = await getDb();
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation(((...a: Parameters<typeof select>) => (order.push("read"), select(...a))) as typeof select);
    expect((await renderPage(WorkflowYamlPage, { owner, slug: "dinners" })).status).toBe(200);
    expect(order[0]).toBe("start");
    expect(order.filter((o) => o === "start")).toHaveLength(1);
  });

  it("hides Mermaid's text in the frame while it draws, when the browser runs scripts, unless Mermaid can't draw it", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/app/site.css"), "utf8");
    expect(css).toContain(
      "@media (scripting: enabled) { .panzoom:not(.drawn) .drawing:not(.failed) pre { display: none; } }",
    );
  });
});

describe("the engine's answers, worked out once", () => {
  it("answers the same arguments from what it worked out before, and different ones afresh", async () => {
    const work = vi.fn(async (a: string, b = "") => ({ said: a + b }));
    const once = memoise(work);
    expect(await once("x")).toEqual({ said: "x" });
    expect(await once("x")).toEqual({ said: "x" });
    expect(await once("x", "y")).toEqual({ said: "xy" });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("gives each caller its own copy, so one can't change another's answer", async () => {
    const once = memoise(async () => ({ list: ["a"] }));
    (await once()).list.push("b");
    expect(await once()).toEqual({ list: ["a"] });
  });

  it("keeps only the newest answers, up to its limit", async () => {
    const work = vi.fn(async (a: string) => a);
    const once = memoise(work, 2);
    await once("a");
    await once("b");
    await once("a");
    await once("c");
    expect(work).toHaveBeenCalledTimes(3);
    // "b" was the oldest used, so it went to make room for "c".
    await once("a");
    await once("b");
    expect(work).toHaveBeenCalledTimes(4);
  });

  it("forgets a failure, so the next call tries again", async () => {
    let fail = true;
    const once = memoise(async () => {
      if (fail) throw new Error("not yet");
      return "done";
    });
    await expect(once()).rejects.toThrow("not yet");
    fail = false;
    expect(await once()).toBe("done");
  });
});
