// Systems: several workflows, given to the engine together, stored and seen
// together at /{owner}/systems/{slug}. A system's version holds a title, a
// Markdown description and its members as owner/slug, which follow their
// latest version. Its page draws the map of the members the viewer may see,
// checks them together, says who waits and where they run, and leaves out
// every member the viewer may not see, saying only how many there are.
import { describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent, systemMember, version, workflow as workflowTable } from "@/db/schema";
import { engine } from "@/engine";
import { addMember, createOrganisation, removeMember } from "@/server/organisations";
import { readSystemVersion } from "@/server/systems";
import { listTokens, revokeToken } from "@/server/tokens";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import { loadSystem } from "@/app/[owner]/systems/[slug]/load";
import { loadVersion } from "@/app/[owner]/[slug]/load";
import SystemChecksPage from "@/app/[owner]/systems/[slug]/checks/page";
import SystemWaitsPage from "@/app/[owner]/systems/[slug]/who-waits/page";
import SystemRunsPage from "@/app/[owner]/systems/[slug]/where-it-runs/page";
import SystemVersionPage from "@/app/[owner]/systems/[slug]/v/[n]/page";
import SystemVersionChecksPage from "@/app/[owner]/systems/[slug]/v/[n]/checks/page";
import SystemVersionWaitsPage from "@/app/[owner]/systems/[slug]/v/[n]/who-waits/page";
import SystemVersionRunsPage from "@/app/[owner]/systems/[slug]/v/[n]/where-it-runs/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import OwnerPage from "@/app/[owner]/page";
import GalleryPage from "@/app/gallery/page";
import { BASE, example, orgWith, person, request, storeVersion, type Who } from "./helpers";
import { call } from "./mcp-client";
import { pageRequest, renderPage } from "./pages";
import { laidOut } from "./drawn";

// A workflow that the fit can judge: one scope any company may process, a
// trigger that waits up to an hour, a note kept in the scope and a step a
// person takes, each labelled so a test can find it on a page.
const workflow = (title: string, words: string) => `awml: "0.7"
title: ${title}
scopes:
  - { id: home, label: "home: the family", processing: any }
parts:
  - { id: tick, kind: trigger, label: "Every morning", wait: PT1H, in: home }
  - { id: note, kind: context, label: "${words} note", in: home }
  - { id: step, kind: person, op: do, label: "${words} step", in: home }
lines:
  - { from: tick, to: step, kind: start }
  - { from: step, to: note, kind: data }
`;

async function pushWorkflow(owner: string, slug: string, as: Who, file: string, visibility: "public" | "private") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow: file, visibility } });
  expect(res.status, await res.clone().text()).toBe(201);
}

const pushSystem = async (owner: string, slug: string, as: Who, json: Record<string, unknown>) => {
  const res = await request("POST", `/api/v1/${owner}/systems/${slug}/versions`, { as, json });
  return { status: res.status, body: await res.json() };
};

async function pushedSystem(owner: string, slug: string, as: Who, json: Record<string, unknown>) {
  const res = await pushSystem(owner, slug, as, json);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

// Ana owns acme, with Mo as a member; Bea owns beta. Nell belongs to nothing.
// acme/shopping is public and acme/dinners private; ana/notes is Ana's own,
// private; beta/bakes is public and beta/secret private.
async function world() {
  const ana = await person("ana");
  const mo = await person("mo");
  const bea = await person("bea");
  const nell = await person("nell");
  await orgWith("acme", ana, [mo]);
  await orgWith("beta", bea);
  await pushWorkflow("acme", "shopping", { token: ana.token }, workflow("Shopping", "Shopping"), "public");
  await pushWorkflow("acme", "dinners", { token: ana.token }, workflow("Dinners", "Dinners"), "private");
  await pushWorkflow("ana", "notes", { token: ana.token }, workflow("Notes", "Notes"), "private");
  await pushWorkflow("beta", "bakes", { token: bea.token }, workflow("Bakes", "Bakes"), "public");
  await pushWorkflow("beta", "secret", { token: bea.token }, workflow("Secret recipes", "Secret sauce"), "private");
  await pushPlatform("acme", "worker", { token: ana.token }, example("platforms/worker.yaml"), "public");
  return { ana, mo, bea, nell };
}

async function pushPlatform(owner: string, slug: string, as: Who, description: string, visibility: "public" | "private") {
  const res = await request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, { as, json: { description, visibility } });
  expect(res.status, await res.clone().text()).toBe(201);
}

// A platform with its own id and label, so a page shows whether it was judged.
const describedAs = (id: string, label: string) =>
  example("platforms/worker.yaml").replace('{ id: worker, label: "A code worker" }', `{ id: ${id}, label: "${label}" }`);

const kitchen = (members: string[], more: Record<string, unknown> = {}) => ({
  title: "Kitchen",
  description: "Everything that keeps the **kitchen** going.\n\n<script>alert(1)</script>",
  members,
  ...more,
});

// The refusal of a member the system's owner may not hold, the same whether
// it is private to the owner, private to the pusher or missing.
const ACME_MAY_HOLD = "is not a workflow acme's systems may hold: a public one, or one of acme's own.";
const ANA_MAY_HOLD =
  "is not a workflow ana's systems may hold: a public one, one of ana's own, or one of an organisation ana belongs to.";

type Tab = "map" | "checks" | "who-waits" | "where-it-runs";
const TABS: Tab[] = ["map", "checks", "who-waits", "where-it-runs"];
const LATEST = { map: SystemPage, checks: SystemChecksPage, "who-waits": SystemWaitsPage, "where-it-runs": SystemRunsPage };
const VERSION = {
  map: SystemVersionPage,
  checks: SystemVersionChecksPage,
  "who-waits": SystemVersionWaitsPage,
  "where-it-runs": SystemVersionRunsPage,
};

const asCookie = (who?: { cookie: string }) => (who ? { cookie: who.cookie } : undefined);

const tab = (owner: string, slug: string, which: Tab, who?: { cookie: string }) =>
  renderPage(LATEST[which], { owner, slug }, { as: asCookie(who) });

const versionTab = (owner: string, slug: string, n: string, which: Tab, who?: { cookie: string }) =>
  renderPage(VERSION[which], { owner, slug, n }, { as: asCookie(who) });

// Every tab of a system's latest version and of its version 1, as someone.
async function everyTab(owner: string, slug: string, who?: { cookie: string }) {
  const pages = [];
  for (const which of TABS) {
    pages.push(await tab(owner, slug, which, who));
    pages.push(await versionTab(owner, slug, "1", which, who));
  }
  return pages;
}

describe("pushing a system", () => {
  it("saves a numbered version through the API, answering as a workflow push does", async () => {
    const { ana } = await world();
    const first = await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "acme/dinners"]));
    expect(first).toEqual({ owner: "acme", slug: "kitchen", number: 1, url: `${BASE}/acme/systems/kitchen/v/1` });
    const second = await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    expect(second.number).toBe(2);
  });

  it("saves one through the MCP tool publish_system, with the same fields", async () => {
    const { ana } = await world();
    const done = await call(
      "publish_system",
      { owner: "acme", slug: "kitchen", title: "Kitchen", description: "The kitchen.", members: ["acme/shopping"], visibility: "private" },
      ana.token,
    );
    expect(done.isError, done.text).toBe(false);
    expect(done.data).toEqual({ owner: "acme", slug: "kitchen", number: 1, url: `${BASE}/acme/systems/kitchen` });
    expect((await tab("acme", "kitchen", "map")).status).toBe(404);
    expect((await tab("acme", "kitchen", "map", ana)).html).toContain("Kitchen");
  });

  it("refuses a system with no members, a member named twice, a badly written member or no title", async () => {
    const { ana } = await world();
    const as = { token: ana.token };
    const none = await pushSystem("acme", "kitchen", as, kitchen([]));
    expect(none).toEqual({ status: 422, body: { errors: ["members: name at least one workflow, as owner/slug."] } });
    const twice = await pushSystem("acme", "kitchen", as, kitchen(["acme/shopping", "acme/shopping"]));
    expect(twice).toEqual({ status: 422, body: { errors: ["members: acme/shopping is named twice."] } });
    const bad = await pushSystem("acme", "kitchen", as, kitchen(["shopping"]));
    expect(bad).toEqual({ status: 422, body: { errors: ['members: "shopping" is not owner/slug.'] } });
    const untitled = await pushSystem("acme", "kitchen", as, kitchen(["acme/shopping"], { title: "" }));
    expect(untitled).toEqual({ status: 422, body: { errors: ["title: give the system a title."] } });
    const described = await pushSystem("acme", "kitchen", as, kitchen(["acme/shopping"], { description: 7 }));
    expect(described).toEqual({ status: 422, body: { errors: ["description: send it as Markdown text."] } });
    expect((await tab("acme", "kitchen", "map", ana)).status).toBe(404);
  });

  it("refuses a member the pusher may not see with the same 422 as a missing one", async () => {
    const { ana } = await world();
    const hidden = await pushSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "beta/secret"]));
    const missing = await pushSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "beta/nothing"]));
    expect(hidden).toEqual({ status: 422, body: { errors: [`members: beta/secret ${ANA_MAY_HOLD}`] } });
    expect(missing).toEqual({ status: 422, body: { errors: [`members: beta/nothing ${ANA_MAY_HOLD}`] } });
    const toAcme = await pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/secret"]));
    expect(toAcme).toEqual({ status: 422, body: { errors: [`members: beta/secret ${ACME_MAY_HOLD}`] } });
  });

  it("refuses an organisation's system a member's own private workflow, with the same 422 as a missing one", async () => {
    const { ana } = await world();
    const personal = await pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "ana/notes"]));
    const missing = await pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "ana/nothing"]));
    expect(personal).toEqual({ status: 422, body: { errors: [`members: ana/notes ${ACME_MAY_HOLD}`] } });
    expect(missing).toEqual({ status: 422, body: { errors: [`members: ana/nothing ${ACME_MAY_HOLD}`] } });
    expect((await tab("acme", "kitchen", "map", ana)).status).toBe(404);
  });

  it("refuses an organisation's system another organisation's private workflow, even from someone in both", async () => {
    const { ana, bea } = await world();
    const joined = await addMember(await getDb(), bea.id, "beta", "ana", "member");
    expect(joined.ok).toBe(true);
    const other = await pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/secret"]));
    const missing = await pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/nothing"]));
    expect(other).toEqual({ status: 422, body: { errors: [`members: beta/secret ${ACME_MAY_HOLD}`] } });
    expect(missing).toEqual({ status: 422, body: { errors: [`members: beta/nothing ${ACME_MAY_HOLD}`] } });
    expect((await tab("acme", "kitchen", "map", ana)).status).toBe(404);
    // Her own system takes the private workflows of both her organisations.
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["beta/secret", "acme/dinners"], { visibility: "private" }));
    const map = await tab("ana", "home", "map", ana);
    expect(map.html).toContain('href="/beta/secret"');
    expect(map.html).toContain('href="/acme/dinners"');
  });

  it("takes another owner's public workflow into a person's system and an organisation's, beside each owner's private ones", async () => {
    const { ana } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["beta/bakes", "ana/notes", "acme/dinners"], { visibility: "private" }));
    const map = await tab("ana", "home", "map", ana);
    expect(map.html).toContain('href="/beta/bakes"');
    for (const title of ["Bakes", "Notes", "Dinners"]) expect(map.html).toContain(title);
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["beta/bakes", "acme/dinners"]));
    const acmeMap = await tab("acme", "kitchen", "map", ana);
    expect(acmeMap.html).toContain('href="/beta/bakes"');
    expect(acmeMap.html).toContain('href="/acme/dinners"');
  });

  it("lets nobody push to an owner they can't push workflows to", async () => {
    const { ana, bea, nell } = await world();
    const members = kitchen(["acme/shopping"]);
    expect((await pushSystem("acme", "kitchen", { token: nell.token }, members)).status).toBe(403);
    expect((await pushSystem("acme", "kitchen", undefined, members)).status).toBe(401);
    expect((await pushSystem("ana", "kitchen", { token: bea.token }, kitchen(["beta/bakes"]))).status).toBe(403);
  });

  it("answers a stranger's push to a private system exactly as to a missing one, so it never says one is there", async () => {
    const { ana, bea, nell } = await world();
    const members = kitchen(["acme/shopping"]);
    await pushedSystem("acme", "private", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    await pushedSystem("ana", "private", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    for (const who of [nell, bea]) {
      const toPrivate = await pushSystem("acme", "private", { token: who.token }, members);
      expect(toPrivate).toEqual({ status: 403, body: { errors: ["Only members of acme can push here."] } });
      expect(await pushSystem("acme", "missing", { token: who.token }, members)).toEqual(toPrivate);
      const toPersons = await pushSystem("ana", "private", { token: who.token }, members);
      expect(toPersons).toEqual({ status: 403, body: { errors: ["Only ana can push here."] } });
      expect(await pushSystem("ana", "missing", { token: who.token }, members)).toEqual(toPersons);
    }
    expect((await tab("acme", "private", "map", ana)).html).toContain("Version 1 of 1");
  });

  it("refuses a later push that changes the system's visibility, either way", async () => {
    const { ana } = await world();
    const as = { token: ana.token };
    await pushedSystem("acme", "kitchen", as, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "larder", as, kitchen(["acme/shopping"], { visibility: "private" }));
    expect(await pushSystem("acme", "kitchen", as, kitchen(["acme/shopping"], { visibility: "private" }))).toEqual({
      status: 422,
      body: { errors: ["This system is public. Its first push set that, and a later push cannot change it."] },
    });
    expect(await pushSystem("acme", "larder", as, kitchen(["acme/shopping"], { visibility: "public" }))).toEqual({
      status: 422,
      body: { errors: ["This system is private. Its first push set that, and a later push cannot change it."] },
    });
    expect((await tab("acme", "kitchen", "map")).html).toContain("System · Public · ");
    expect((await tab("acme", "larder", "map")).status).toBe(404);
    // A push that says the visibility it already has is taken.
    expect((await pushedSystem("acme", "larder", as, kitchen(["acme/shopping"], { visibility: "private" }))).number).toBe(2);
  });

  it("records a push to an organisation's system in its audit log, and nothing for a person's", async () => {
    const { ana, mo } = await world();
    await pushedSystem("acme", "kitchen", { token: mo.token }, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "acme/dinners"]));
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping"]));
    const pushes = await (await getDb())
      .select({ actor: auditEvent.actorId, target: auditEvent.target })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "push"), like(auditEvent.target, "%/systems/%")));
    expect(pushes).toEqual([
      { actor: mo.id, target: "acme/systems/kitchen v1" },
      { actor: ana.id, target: "acme/systems/kitchen v2" },
    ]);
  });

  it("lets an organisation's member push as its owner does, and see its private members", async () => {
    const { mo } = await world();
    await pushedSystem("acme", "kitchen", { token: mo.token }, kitchen(["acme/dinners"], { visibility: "private" }));
    const map = await tab("acme", "kitchen", "map", mo);
    expect(map.html).toContain('href="/acme/dinners"');
    expect(map.html).not.toContain("private workflow");
  });

  it("gives a revoked or made-up token the same 401 for a private, a public and a missing system", async () => {
    const { ana, nell } = await world();
    await pushedSystem("acme", "open", { token: ana.token }, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "closed", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    const [listed] = await listTokens(await getDb(), nell.id);
    await revokeToken(await getDb(), nell.id, listed.id);
    for (const token of [nell.token, "awml_made_up"]) {
      const answers = [];
      for (const slug of ["open", "closed", "missing"])
        answers.push(await pushSystem("acme", slug, { token }, kitchen(["acme/shopping"])));
      expect(answers.map((a) => a.status)).toEqual([401, 401, 401]);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    }
  });

  it("keeps the slug systems from any workflow", async () => {
    const { ana } = await world();
    const res = await request("POST", "/api/v1/acme/systems/versions", {
      as: { token: ana.token },
      json: { workflow: workflow("Systems", "Systems") },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(['"systems" is reserved.']);
    const done = await call("publish", { owner: "acme", slug: "systems", workflow: workflow("Systems", "Systems") }, ana.token);
    expect(done.isError).toBe(true);
    expect(done.text).toBe('"systems" is reserved.');
  });
});

describe("a system's page", () => {
  it("shows its owner every member on every tab, with its title, version and description", async () => {
    const { ana } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "acme/dinners", "ana/notes"]));
    const [map, mapV1, checks, checksV1, waits, waitsV1, runs, runsV1] = [
      await tab("ana", "home", "map", ana),
      await versionTab("ana", "home", "1", "map", ana),
      await tab("ana", "home", "checks", ana),
      await versionTab("ana", "home", "1", "checks", ana),
      await tab("ana", "home", "who-waits", ana),
      await versionTab("ana", "home", "1", "who-waits", ana),
      await tab("ana", "home", "where-it-runs", ana),
      await versionTab("ana", "home", "1", "where-it-runs", ana),
    ];
    for (const page of [map, mapV1, checks, checksV1, waits, waitsV1, runs, runsV1]) {
      expect(page.status).toBe(200);
      expect(page.html).toContain("<h1>Kitchen</h1>");
      expect(page.html).toContain("Version 1 of 1");
      // The description as Markdown, any HTML in it shown as text.
      expect(page.html).toContain("<strong>kitchen</strong>");
      expect(page.html).not.toContain("<script>");
      for (const member of ["acme/shopping", "acme/dinners", "ana/notes"]) expect(page.html).toContain(`href="/${member}"`);
      expect(page.html).not.toContain("shown incomplete");
    }
    // The map draws a box for each workflow, named by its title, which opens its page (#61).
    for (const [words, member] of [["Shopping", "acme/shopping"], ["Dinners", "acme/dinners"], ["Notes", "ana/notes"]]) {
      for (const page of [map, mapV1]) expect(page.html).toContain(`<a href="/${member}" aria-label="Open ${words}">`);
      for (const page of [waits, waitsV1]) expect(page.html).toContain(`${words} step`);
    }
    for (const member of ["acme/shopping", "acme/dinners", "ana/notes"]) expect(checks.html).toContain(`${member}.yaml`);
    for (const page of [runs, runsV1]) {
      expect(page.html).toContain('<a href="/acme/platforms/worker">A code worker</a>');
      expect(page.html).toMatch(/<strong>(Runs them all|Doesn&#x27;t run them all)<\/strong>/);
    }
  });

  it("fits the members against the owner's platforms the viewer may see and the public ones, and no other", async () => {
    const { ana, bea } = await world();
    await pushPlatform("acme", "pantry", { token: ana.token }, describedAs("pantry", "Acme's pantry"), "private");
    await pushPlatform("beta", "oven", { token: bea.token }, describedAs("oven", "Beta's oven"), "private");
    await pushPlatform("beta", "stall", { token: bea.token }, describedAs("stall", "Beta's stall"), "public");
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    const toAna = await tab("acme", "kitchen", "where-it-runs", ana);
    expect(toAna.html).toContain("Acme&#x27;s pantry");
    expect(toAna.html).toContain("Beta&#x27;s stall");
    expect(toAna.html).not.toContain("oven");
    // Bea may see beta's private oven, but it is not the system's owner's.
    const toBea = await tab("acme", "kitchen", "where-it-runs", bea);
    expect(toBea.html).toContain("Beta&#x27;s stall");
    expect(toBea.html).not.toContain("oven");
    expect(toBea.html).not.toContain("pantry");
  });

  it("is a 404 to a stranger and a visitor when private, on every tab, as a missing one is", async () => {
    const { ana, nell, bea } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    for (const who of [nell, bea, undefined]) {
      for (const page of await everyTab("acme", "kitchen", who)) expect(page.status).toBe(404);
      for (const page of await everyTab("acme", "missing", who)) expect(page.status).toBe(404);
    }
    for (const page of await everyTab("acme", "kitchen", ana)) expect(page.status).toBe(200);
  });

  it("shows a stranger a public system's private member as 1 private workflow, and nothing of it on any tab", async () => {
    const { ana, nell } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "ana/notes"]));
    for (const who of [nell, undefined]) {
      for (const page of await everyTab("ana", "home", who)) {
        expect(page.status).toBe(200);
        expect(page.html).toContain("1 private workflow");
        expect(page.html).toContain("shown incomplete");
        expect(page.html).toContain('href="/acme/shopping"');
        expect(page.html).not.toContain("ana/notes");
        // Nothing of it: its title, its parts' labels, nor the fit's names
        // for its parts, such as notes#home.
        expect(page.html).not.toMatch(/notes/i);
      }
    }
  });

  it("never sends a viewer a member they may not see: no box, no part and no link in the map's drawing", async () => {
    const { ana, bea } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "ana/notes", "acme/dinners"]));
    // What the page hands the browser to draw, as Bea and as someone signed out.
    const panelAs = async (who?: { cookie: string }) => {
      pageRequest.headers = new Headers();
      if (who) pageRequest.headers.set("cookie", who.cookie);
      return (await loadSystem("ana", "home", "latest", "map")).panel;
    };
    for (const panel of [await panelAs(bea), await panelAs()]) {
      const sent = JSON.stringify(panel);
      expect(sent).toContain("Shopping note");
      for (const hidden of ["Notes", "Dinners", "ana/notes", "acme/dinners"]) expect(sent).not.toContain(hidden);
      // With one member drawn, the map is that workflow's own drawing, with no box to open.
      expect(panel).toMatchObject({ hrefs: {} });
    }
    // Ana, who may see all three, gets a box for each, each leading to its page.
    const own = await panelAs(ana);
    expect(own).toMatchObject({ hrefs: { w1: "/acme/shopping", w2: "/ana/notes", w3: "/acme/dinners" } });
    if (own.tab !== "map" || !own.drawing) throw new Error("no map");
    expect(laidOut(own.drawing).full.scopes.map((sc) => [sc.id, sc.lines.join(" ")])).toEqual([
      ["w1", "Shopping"],
      ["w2", "Notes"],
      ["w3", "Dinners"],
    ]);
  });

  it("counts two hidden members as 2 private workflows, whoever's they are", async () => {
    const { ana, bea } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "ana/notes", "acme/dinners"]));
    const map = await tab("ana", "home", "map", bea);
    expect(map.html).toContain("2 private workflows");
    expect(map.html).not.toContain("Dinners");
    expect(map.html).not.toContain("Notes");
  });

  it("draws a part two members share once, by the ref between them, and says who shares it", async () => {
    const { ana } = await world();
    const meals = `awml: "0.7"
title: Meals
scopes:
  - { id: home, label: "home: the family", processing: any }
parts:
  - { id: tick, kind: trigger, label: "Every evening", wait: PT1H, in: home }
  - { id: note, kind: context, label: "Shopping note", in: home, ref: acme/shopping#note }
  - { id: cook, kind: code, op: do, label: "Cook", in: home }
lines:
  - { from: tick, to: cook, kind: start }
  - { from: note, to: cook, kind: data }
`;
    await pushWorkflow("acme", "meals", { token: ana.token }, meals, "public");
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "acme/meals"]));
    const map = await tab("acme", "kitchen", "map");
    expect(map.html.match(/Shopping note/g)).toHaveLength(1);
    const waits = await tab("acme", "kitchen", "who-waits");
    expect(waits.html).toContain("Shared between workflows");
    expect(waits.html).toMatch(/Shopping note<span class="note"> · Shopping, Meals<\/span>/);
  });

  it("says so on every tab when the viewer may see none of its members", async () => {
    const { ana, nell } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["ana/notes"]));
    const [map, checks, waits, runs] = [
      await tab("ana", "home", "map", nell),
      await tab("ana", "home", "checks", nell),
      await tab("ana", "home", "who-waits", nell),
      await tab("ana", "home", "where-it-runs", nell),
    ];
    expect(checks.html).toContain("There are no workflows you can see in this system to check.");
    for (const page of [map, waits, runs]) expect(page.html).toContain("None of the workflows you can see in this system is drawn.");
    for (const page of [map, checks, waits, runs]) expect(page.html).toContain("1 private workflow");
  });

  it("follows each member's latest version, without a new version of the system", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    expect((await tab("acme", "kitchen", "who-waits")).html).toContain("Shopping step");
    await pushWorkflow("acme", "shopping", { token: ana.token }, workflow("Shopping", "Groceries"), "public");
    const waits = await tab("acme", "kitchen", "who-waits");
    expect(waits.html).toContain("Groceries step");
    expect(waits.html).not.toContain("Shopping step");
    expect(waits.html).toContain("Version 1 of 1");
  });

  it("lists a member whose latest version fails check as not drawn, and leaves it out of the map", async () => {
    const { ana } = await world();
    await pushWorkflow("acme", "broken", { token: ana.token }, workflow("Broken", "Broken"), "public");
    await storeVersion("acme", "broken", ana, { workflow: example("bad.yaml") }, {
      summary: (await (await request("GET", "/api/v1/acme/shopping/v/1")).json()).summary,
    });
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "acme/broken"]));
    const map = await tab("acme", "kitchen", "map");
    expect(map.html).toContain('href="/acme/broken"');
    expect(map.html).toContain(" · acme/broken · not drawn");
    expect(map.html).not.toContain(" · acme/shopping · not drawn");
    // With one member drawn, the map is its drawing, without the broken one's parts.
    const drawing = /<svg class="flow-static"[\s\S]*?<\/svg>/.exec(map.html)![0];
    expect(drawing).toContain("Shopping note");
    expect(drawing).not.toMatch(/Start|Work/);
    const checks = await tab("acme", "kitchen", "checks");
    expect(checks.html).toContain("acme/broken.yaml");
    expect(checks.html).toContain("ends at unknown part");
  });

  it("treats a member made private after it was added as any private member", async () => {
    const { ana, nell } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    await (await getDb()).update(workflowTable).set({ visibility: "private" }).where(eq(workflowTable.slug, "bakes"));
    const map = await tab("acme", "kitchen", "map", nell);
    expect(map.html).toContain("1 private workflow");
    expect(map.html).not.toContain("Bakes");
  });

  it("shows another organisation's member and a visitor an organisation's public system holding its own private workflow as 1 private workflow, and nothing of it on any tab", async () => {
    const { ana, bea } = await world();
    await pushWorkflow("acme", "pantry", { token: ana.token }, workflow("Pantry", "Pantry"), "private");
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "acme/pantry"]));
    for (const who of [bea, undefined]) {
      for (const page of await everyTab("acme", "kitchen", who)) {
        expect(page.status).toBe(200);
        expect(page.html).toContain("1 private workflow");
        expect(page.html).toContain("shown incomplete");
        expect(page.html).toContain('href="/acme/shopping"');
        expect(page.html).not.toMatch(/pantry/i);
      }
    }
    for (const page of await everyTab("acme", "kitchen", ana)) {
      expect(page.html).toContain('href="/acme/pantry"');
      expect(page.html).not.toContain("private workflow");
    }
  });

  it("hides an organisation's private workflow on a person's public system from that person once they leave it", async () => {
    const { ana, mo } = await world();
    await pushedSystem(mo.username, "home", { token: mo.token }, kitchen(["acme/shopping", "acme/dinners"]));
    expect((await tab(mo.username, "home", "map", mo)).html).toContain('href="/acme/dinners"');
    const left = await removeMember(await getDb(), mo.id, "acme", mo.id);
    expect(left.ok).toBe(true);
    for (const page of await everyTab(mo.username, "home", mo)) {
      expect(page.status).toBe(200);
      expect(page.html).toContain("1 private workflow");
      expect(page.html).toContain('href="/acme/shopping"');
      expect(page.html).not.toMatch(/dinners/i);
    }
    expect((await tab(mo.username, "home", "map", ana)).html).toContain('href="/acme/dinners"');
  });

  it("checks another owner's public member on the Checks tab, listed read-only with the system's own", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    for (const who of [ana, undefined]) {
      const checks = await tab("acme", "kitchen", "checks", who);
      expect(checks.html).toContain('href="/beta/bakes"');
      expect(checks.html).toContain(" · beta/bakes");
      expect(checks.html).not.toContain(" · beta/bakes · not drawn");
      const bakes = /<h2>beta\/bakes\.yaml<\/h2>[\s\S]*?<\/section>/.exec(checks.html)?.[0] ?? "";
      expect(bakes).toContain("data-check=");
      expect(bakes).toContain("Passed");
      expect(bakes).not.toContain("badge bad");
    }
  });

  it("shows a deleted member to its owner as missing, and to anyone else as a private workflow", async () => {
    const { ana, bea, nell } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    await (await getDb()).delete(workflowTable).where(eq(workflowTable.slug, "bakes"));
    const toBea = await tab("acme", "kitchen", "map", bea);
    expect(toBea.html).toContain("beta/bakes");
    expect(toBea.html).toContain("missing");
    expect(toBea.html).not.toContain('href="/beta/bakes"');
    const toNell = await tab("acme", "kitchen", "map", nell);
    expect(toNell.html).toContain("1 private workflow");
    expect(toNell.html).not.toContain("beta/bakes");
  });

  it("knows a deleted member's owner by account, so whoever takes its owner's name after never sees it", async () => {
    const { ana, nell } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "ana/notes"]));
    const rename = (who: { token: string }, username: string) =>
      request("PATCH", "/api/v1/me", { as: { token: who.token }, json: { username } });
    expect((await rename(ana, "ana-cooks")).status).toBe(200);
    expect((await rename(nell, "ana")).status).toBe(200);
    await (await getDb()).delete(workflowTable).where(eq(workflowTable.slug, "notes"));
    const toAna = await tab("ana-cooks", "home", "map", ana);
    expect(toAna.html).toContain("ana/notes");
    expect(toAna.html).toContain("missing");
    const toNell = await tab("ana-cooks", "home", "map", nell);
    expect(toNell.html).toContain("1 private workflow");
    expect(toNell.html).not.toMatch(/notes/i);
  });

  it("sends each tab under a name its person gave up to the same tab under their new one", async () => {
    const { ana } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping"]));
    const renamed = await request("PATCH", "/api/v1/me", { as: { token: ana.token }, json: { username: "ana-cooks" } });
    expect(renamed.status).toBe(200);
    expect(await tab("ana", "home", "who-waits")).toMatchObject({ status: 308, location: "/ana-cooks/systems/home/who-waits" });
    expect(await versionTab("ana", "home", "1", "map")).toMatchObject({ status: 308, location: "/ana-cooks/systems/home/v/1" });
    const pushedThere = await request("POST", "/api/v1/ana/systems/home/versions", {
      as: { token: ana.token },
      json: kitchen(["acme/shopping"]),
    });
    expect(pushedThere.status).toBe(308);
    expect(pushedThere.headers.get("location")).toBe(`${BASE}/api/v1/ana-cooks/systems/home/versions`);
  });

  it("records in the audit log that a member viewed a private system", async () => {
    const { ana, mo } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    await tab("acme", "kitchen", "map", mo);
    const events = await (await getDb())
      .select({ action: auditEvent.action, target: auditEvent.target })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "private_view"), eq(auditEvent.target, "acme/systems/kitchen v1")));
    expect(events).toHaveLength(1);
  });

  it("records in an organisation's audit log that a member saw its private workflow on a system, at its latest version, and nothing for a stranger", async () => {
    const { ana, mo, nell } = await world();
    await pushWorkflow("acme", "dinners", { token: ana.token }, workflow("Dinners", "Suppers"), "private");
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "acme/dinners"]));
    const views = async () =>
      (await getDb())
        .select({ actor: auditEvent.actorId })
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "private_view"), eq(auditEvent.target, "acme/dinners v2")));
    await tab("ana", "home", "map", nell);
    expect(await views()).toEqual([]);
    await tab("ana", "home", "map", mo);
    expect(await views()).toEqual([{ actor: mo.id }]);
  });
});

describe("the systems a member is in", () => {
  it("lists on a member's page and in the API each system it's in that the viewer may see", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    const page = await renderPage(WorkflowPage, { owner: "beta", slug: "bakes" });
    expect(page.html).toMatch(/In <a href="\/acme\/systems\/kitchen">Kitchen<\/a>/);
    const api = await (await request("GET", "/api/v1/beta/bakes")).json();
    expect(api.systems).toEqual([{ owner: "acme", slug: "kitchen", title: "Kitchen", visibility: "public" }]);
  });

  it("never lists or counts a private system to anyone outside it", async () => {
    const { ana, bea, nell } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["beta/bakes"], { visibility: "private" }));
    for (const who of [bea, nell, undefined]) {
      const page = await renderPage(WorkflowPage, { owner: "beta", slug: "bakes" }, { as: asCookie(who) });
      expect(page.html).not.toContain("Kitchen");
      expect(page.html).not.toContain("/systems/");
      const api = await (await request("GET", "/api/v1/beta/bakes", { as: who ? { token: who.token } : undefined })).json();
      expect(api.systems).toEqual([]);
    }
    const toAna = await renderPage(WorkflowPage, { owner: "beta", slug: "bakes" }, { as: asCookie(ana) });
    expect(toAna.html).toContain('href="/acme/systems/kitchen"');
  });

  it("goes by each system's latest version", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]));
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    const api = await (await request("GET", "/api/v1/beta/bakes")).json();
    expect(api.systems).toEqual([]);
  });
});

describe("finding systems", () => {
  it("lists an owner's systems on their page, a private one only to those inside it", async () => {
    const { ana, nell } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "larder", { token: ana.token }, { ...kitchen(["acme/shopping"]), title: "Larder", visibility: "private" });
    const toAna = await renderPage(OwnerPage, { owner: "acme" }, { as: asCookie(ana) });
    expect(toAna.html).toContain('href="/acme/systems/kitchen"');
    expect(toAna.html).toContain('href="/acme/systems/larder"');
    for (const who of [nell, undefined]) {
      const page = await renderPage(OwnerPage, { owner: "acme" }, { as: asCookie(who) });
      expect(page.html).toContain('href="/acme/systems/kitchen"');
      expect(page.html).not.toContain("larder");
      expect(page.html).not.toContain("Larder");
    }
  });

  it("finds a public system by its title in the gallery's search, and never a private one", async () => {
    const { ana } = await world();
    const as = { token: ana.token };
    await pushedSystem("acme", "kitchen", as, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "larder", as, { ...kitchen(["acme/shopping"]), title: "Kitchen larder", visibility: "private" });
    await pushedSystem("acme", "bakery", as, { ...kitchen(["acme/shopping"]), title: "Bakery" });
    for (const who of [ana, undefined]) {
      const page = await renderPage(GalleryPage, {}, { as: asCookie(who), search: { q: "kitchen" } });
      expect(page.html).toContain('href="/acme/systems/kitchen"');
      expect(page.html).not.toMatch(/larder/i);
      expect(page.html).not.toContain("/acme/systems/bakery");
    }
  });

  it("lists public systems in the gallery's own section, and never a private one", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    await pushedSystem("acme", "larder", { token: ana.token }, { ...kitchen(["acme/shopping"]), title: "Larder", visibility: "private" });
    for (const who of [ana, undefined]) {
      const page = await renderPage(GalleryPage, {}, { as: asCookie(who) });
      expect(page.html).toContain("<h2>Systems</h2>");
      expect(page.html).toContain('href="/acme/systems/kitchen"');
      expect(page.html).not.toContain("Larder");
    }
  });
});

// D1, where the hosted registry keeps its data, binds at most 100 values in a
// statement; the tests refuse any statement that binds more (test/setup.ts).
describe("a big system, within D1's limit on bound values", () => {
  // n public workflows of acme, acme/many-1 to acme/many-n, written straight
  // to the database, as pushing each would take long.
  async function manyWorkflows(n: number, by: { id: string }) {
    const summary = await engine.summarise({ workflow: workflow("Many", "Many") });
    const names = [];
    for (let i = 1; i <= n; i++) {
      await storeVersion("acme", `many-${i}`, by, { workflow: workflow(`Many ${i}`, `Many ${i}`) }, { summary });
      names.push(`acme/many-${i}`);
    }
    return names;
  }

  it("pushes a system of 101 workflows and reads every one back, in the order pushed", async () => {
    const { ana } = await world();
    const members = await manyWorkflows(101, ana);
    await pushedSystem("acme", "big", { token: ana.token }, kitchen(members));
    const read = (await readSystemVersion(await getDb(), null, "acme", "big", "latest"))!;
    expect(read.members.map((m) => `${m.owner}/${m.slug}`)).toEqual(members);
    expect(read.hidden).toBe(0);
  });

  it("leaves no version behind when its members can't all be written", async () => {
    const { ana } = await world();
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    const db = await getDb();
    const insert = db.insert.bind(db);
    const refused = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof insert>[0]) => {
      if (table === systemMember) throw new Error("D1 refused it");
      return insert(table);
    }) as typeof db.insert);
    await expect(pushSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping", "beta/bakes"]))).rejects.toThrow(
      "D1 refused it",
    );
    refused.mockRestore();
    const map = await tab("acme", "kitchen", "map");
    expect(map.html).toContain("Version 1 of 1");
    expect(map.html).not.toContain("beta/bakes");
    expect((await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]))).number).toBe(2);
  });

  it("shows a person in 101 organisations a workflow's systems, referrers and forks", async () => {
    const { ana } = await world();
    const db = await getDb();
    for (let i = 1; i <= 101; i++) {
      const made = await createOrganisation(db, ana.id, { slug: `club-${i}`, name: `Club ${i}` });
      expect(made.ok).toBe(true);
    }
    await pushedSystem("acme", "kitchen", { token: ana.token }, kitchen(["acme/shopping"]));
    const page = await renderPage(WorkflowPage, { owner: "acme", slug: "shopping" }, { as: asCookie(ana) });
    expect(page.status).toBe(200);
    expect(page.html).toMatch(/In <a href="\/acme\/systems\/kitchen">Kitchen<\/a>/);
  });
});

// AWML 0.7 starts another workflow with an outside action whose ref names that workflow's
// trigger (awml#109), and the engine's map draws a line from the action to the trigger it starts
// (awml#122). Given together, as a system gives its members, untrusted text follows the action
// into the workflow it starts (awml#112). The bakery's stock count starts its supplier order:
// AWML's own example, pushed with its path refs, as bakery-stock and bakery-order.
describe("a system whose members start one another", () => {
  // The supplier order with no review before the order is placed, so text that reaches it from
  // the stock count reaches its outside action.
  const unreviewed = (order: string) =>
    order
      .replace(/\n  - \{ id: approve, kind: review[^\n]*/, "")
      .replace("{ from: ask, to: approve, kind: start }", "{ from: ask, to: place, kind: start }")
      .replace(/\n  - \{ from: approve, to: place[^\n]*/, "")
      .replace("Place the order: Ask", "Place the order: Allow");
  const untrusted = (stock: string) =>
    stock.replace('{ id: close, kind: trigger, label: "Every day 18:00" }', '{ id: close, kind: trigger, label: "Every day 18:00", untrusted: true }');

  // Ana's organisation acme holds the two, private, so each may refer to the other before it is
  // pushed; the order first, then the stock count, whose action is checked against the order.
  async function bakery(stock = example("bakery-stock.yaml"), order = example("bakery-order.yaml")) {
    const ana = await person("ana");
    const nell = await person("nell");
    await orgWith("acme", ana);
    await pushWorkflow("acme", "bakery-order", { token: ana.token }, order, "private");
    await pushWorkflow("acme", "bakery-stock", { token: ana.token }, stock, "private");
    await pushedSystem("acme", "bakery", { token: ana.token }, { title: "The bakery", members: ["acme/bakery-stock", "acme/bakery-order"], visibility: "private" });
    return { ana, nell };
  }

  const as = async (who: { cookie: string } | undefined, load: () => Promise<unknown>) => {
    pageRequest.headers = new Headers();
    if (who) pageRequest.headers.set("cookie", who.cookie);
    return load();
  };

  it("draws on the map the outside action that starts the other workflow, with a line to its trigger, and leads it there", async () => {
    const { ana } = await bakery();
    const { panel } = (await as(ana, () => loadSystem("acme", "bakery", "latest", "map"))) as Awaited<ReturnType<typeof loadSystem>>;
    if (panel.tab !== "map" || !panel.drawing) throw new Error("no map");
    const { full } = laidOut(panel.drawing);
    expect(full.scopes.map((sc) => [sc.id, sc.workflow])).toEqual([
      ["w1", "acme/bakery-stock"],
      ["w2", "acme/bakery-order"],
    ]);
    expect(full.parts.find((p) => p.id === "w1_start")).toMatchObject({ kind: "outside", lines: ["Start the supplier order"], tier: "Allow", scope: "w1" });
    expect(full.parts.find((p) => p.id === "w2_low")).toMatchObject({ kind: "trigger", lines: ["Flour, butter or sugar runs low"] });
    expect(full.parts.find((p) => p.id === "w2_low")?.scope).toBeUndefined();
    expect(full.lines.find((l) => l.from === "w1_start" && l.to === "w2_low")).toMatchObject({ style: "solid", arrowEnd: true });
    expect(panel.hrefs).toEqual({ w1: "/acme/bakery-stock", w2: "/acme/bakery-order" });
    expect(panel.links?.find((l) => l.part === "w1_start")).toEqual({
      part: "w1_start",
      title: "Starts The bakery's supplier order",
      to: [{ label: "acme/bakery-order", href: "/acme/bakery-order" }],
    });
    const map = (await tab("acme", "bakery", "map", ana)).html;
    expect(map).toContain('<a href="/acme/bakery-order" aria-label="Start the supplier order. Starts The bakery&#x27;s supplier order">');
  });

  it("links the outside action on its workflow's page to the trigger it starts, and that trigger back", async () => {
    const { ana } = await bakery();
    const stock = (await as(ana, () => loadVersion("acme", "bakery-stock", "latest", "security"))) as Awaited<ReturnType<typeof loadVersion>>;
    expect(stock.links.find((l) => l.part === "start")).toEqual({
      part: "start",
      title: "Starts acme/bakery-order#low",
      to: [{ label: "acme/bakery-order", href: "/acme/bakery-order#low" }],
    });
    // A push stored the path ref as owner/slug#id.
    expect(stock.files[0].text).toContain("ref: acme/bakery-order#low");
    const order = (await as(ana, () => loadVersion("acme", "bakery-order", "latest", "security"))) as Awaited<ReturnType<typeof loadVersion>>;
    expect(order.links.find((l) => l.part === "low")).toEqual({
      part: "low",
      title: "Started by acme/bakery-stock",
      to: [{ label: "acme/bakery-stock", href: "/acme/bakery-stock" }],
    });
    expect(order.referredBy.map((r) => [`${r.owner}/${r.slug}`, r.parts])).toEqual([["acme/bakery-stock", ["low"]]]);
  });

  it("follows untrusted text through the action into the workflow it starts, on Checks and Who waits, and not for a file checked alone", async () => {
    const { ana } = await bakery(untrusted(example("bakery-stock.yaml")), unreviewed(example("bakery-order.yaml")));
    const reached = "untrusted text from part &quot;close&quot; in acme/bakery-stock.yaml reaches outside action &quot;place&quot;";
    const checks = await tab("acme", "bakery", "checks", ana);
    const order = checks.html.slice(checks.html.indexOf("acme/bakery-order.yaml"));
    expect(order).toContain(reached);
    expect(checks.html).toContain('<li data-check="warn.untrusted-outside">');
    const waits = (await tab("acme", "bakery", "who-waits", ana)).html;
    expect(waits).toContain("<h2>Where untrusted text reaches</h2>");
    expect(waits).toContain("Every day 18:00<span class=\"note\"> · reaches Start the supplier order: Allow, Place the order: Allow</span>");
    // The supplier order's own Checks tab gives it with the stock count its ref names, so says so
    // too; the list stored at its push, of the file checked alone, doesn't.
    const own = await renderPage(WorkflowChecksPage, { owner: "acme", slug: "bakery-order" }, { as: { cookie: ana.cookie } });
    expect(own.html).toContain(reached);
    const [row] = await (await getDb())
      .select({ checks: version.checks })
      .from(version)
      .innerJoin(workflowTable, eq(workflowTable.id, version.workflowId))
      .where(eq(workflowTable.slug, "bakery-order"));
    expect(row.checks?.checks.find((c) => c.id === "warn.untrusted-outside")).toMatchObject({ result: "pass", mistakes: [] });
  });

  it("shows none of it to someone outside acme", async () => {
    const { nell } = await bakery();
    for (const page of await everyTab("acme", "bakery", nell)) expect(page.status).toBe(404);
  });
});
