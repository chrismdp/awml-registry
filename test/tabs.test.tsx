// Moving between a workflow page's tabs (issue #54): a tab is a client
// navigation, so Mermaid stays loaded; a tab draws only what it shows; the
// engine works out each answer once for the same files; and a diagram tab
// never shows Mermaid's text before its drawing.
import fs from "node:fs";
import path from "node:path";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@/engine";
import { memoise } from "@/engine/memo";
import { VersionView } from "@/components/VersionView";
import { clientHref, TAB_LINKS, TabNavigation } from "@/components/TabNavigation";
import { loadVersion } from "@/app/[owner]/[slug]/load";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import { example, person, request } from "./helpers";
import { renderPage } from "./pages";

afterEach(() => {
  vi.restoreAllMocks();
});

async function pushed() {
  const ana = await person("ana");
  const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
    as: { token: ana.token },
    json: { workflow: example("dinners.yaml") },
  });
  expect(res.status).toBe(201);
  return ana.username;
}

// Every element in a tree of React elements, depth first.
function* elements(node: ReactNode): Generator<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) for (const n of node) yield* elements(n);
  else if (isValidElement(node)) {
    const el = node as unknown as { type: unknown; props: Record<string, unknown> };
    yield el;
    yield* elements(el.props.children as ReactNode);
  }
}

describe("a workflow page's tabs", () => {
  it("moves between the tabs by client navigation on every tab", async () => {
    const owner = await pushed();
    for (const asked of [undefined, "platform", "yaml", "checks"] as const) {
      const tree = VersionView(await loadVersion(owner, "dinners", "latest", asked));
      expect([...elements(tree)].filter((el) => el.type === TabNavigation)).toHaveLength(1);
    }
  });

  it("takes a plain click on a tab or an implementation, and leaves any other click to the browser", () => {
    const tab = { closest: (sel: string) => (sel === TAB_LINKS ? { getAttribute: () => "/ana/dinners/yaml" } : null) };
    const click = (over: Partial<Parameters<typeof clientHref>[0]> = {}) =>
      clientHref({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: tab as never, ...over });
    expect(TAB_LINKS).toBe('.tabs a[role="tab"], nav.implementations a');
    expect(click()).toBe("/ana/dinners/yaml");
    for (const over of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }])
      expect(click(over), JSON.stringify(over)).toBeUndefined();
    expect(click({ target: { closest: () => null } as never })).toBeUndefined();
    // Only an address on this site.
    for (const href of ["//elsewhere.example/x", "https://elsewhere.example/x", "javascript:alert(1)"])
      expect(click({ target: { closest: () => ({ getAttribute: () => href }) } as never }), href).toBeUndefined();
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

  it("hides Mermaid's text in the frame while it draws, when the browser runs scripts", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/app/site.css"), "utf8");
    expect(css).toContain("@media (scripting: enabled) { .panzoom:not(.drawn) .drawing pre { display: none; } }");
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
