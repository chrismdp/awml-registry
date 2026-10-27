// Systems: several workflows, given to the engine together, stored and seen
// together at /{owner}/systems/{slug}. A system's version holds a title, a
// Markdown description and its members as owner/slug, which follow their
// latest version. Its page draws the map of the members the viewer may see,
// checks them together, says who waits and where they run, and leaves out
// every member the viewer may not see, saying only how many there are.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent, workflow as workflowTable } from "@/db/schema";
import { addMember } from "@/server/organisations";
import { listTokens, revokeToken } from "@/server/tokens";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import SystemChecksPage from "@/app/[owner]/systems/[slug]/checks/page";
import SystemWaitsPage from "@/app/[owner]/systems/[slug]/who-waits/page";
import SystemRunsPage from "@/app/[owner]/systems/[slug]/where-it-runs/page";
import SystemVersionPage from "@/app/[owner]/systems/[slug]/v/[n]/page";
import SystemVersionChecksPage from "@/app/[owner]/systems/[slug]/v/[n]/checks/page";
import SystemVersionWaitsPage from "@/app/[owner]/systems/[slug]/v/[n]/who-waits/page";
import SystemVersionRunsPage from "@/app/[owner]/systems/[slug]/v/[n]/where-it-runs/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import OwnerPage from "@/app/[owner]/page";
import GalleryPage from "@/app/gallery/page";
import { BASE, example, orgWith, person, request, storeVersion, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage } from "./pages";

// A workflow that the fit can judge: one scope any company may process, a
// trigger that waits up to an hour, a note kept in the scope and a step a
// person takes, each labelled so a test can find it on a page.
const workflow = (title: string, words: string) => `awml: "0.6"
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
    // A private system answers a stranger's push as a missing one would.
    await pushedSystem("acme", "private", { token: ana.token }, kitchen(["acme/shopping"], { visibility: "private" }));
    const toPrivate = await pushSystem("acme", "private", { token: nell.token }, members);
    expect(toPrivate).toEqual({ status: 404, body: { errors: ["Not found."] } });
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
    // The map draws a box for each workflow, under its title.
    for (const words of ["Shopping", "Dinners", "Notes"]) {
      for (const page of [map, mapV1]) expect(page.html).toContain(`[&quot;${words}&quot;]`);
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
    const meals = `awml: "0.6"
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
    const drawing = /<pre>([\s\S]*)<\/pre>/.exec(map.html)![1];
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

  it("records in an organisation's audit log that a member saw its private workflow on a system, and nothing for a stranger", async () => {
    const { ana, mo, nell } = await world();
    await pushedSystem("ana", "home", { token: ana.token }, kitchen(["acme/shopping", "acme/dinners"]));
    const views = async () =>
      (await getDb())
        .select({ actor: auditEvent.actorId })
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "private_view"), eq(auditEvent.target, "acme/dinners")));
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
