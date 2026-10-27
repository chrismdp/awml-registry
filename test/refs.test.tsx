// References between workflows (AWML 0.6): a part's `ref` names another
// workflow's part. A push rewrites a path ref to the owner pushed to; refs are
// checked against the latest version of what they name, at push and on the
// Checks tab, and only against workflows the reader may see; a public
// workflow refers only to public ones; and a workflow's page lists the
// workflows that refer to it, as far as the viewer may see them.
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { revokeToken, listTokens } from "@/server/tokens";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import { orgWith, person, request, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage } from "./pages";

// A shopping workflow whose list others refer to, and its label.
const shopping = (label = "Shopping list") => `awml: "0.6"
title: Shopping
parts:
  - { id: list, kind: context, label: "${label}" }
  - { id: add, kind: code, op: do, label: "Add what's run out" }
lines:
  - { from: add, to: list, kind: data }
`;

// A dinners workflow that keeps its own copy of the list, referring to it as `ref`.
const dinners = (ref: string, label = "Shopping list") => `awml: "0.6"
title: Dinners
parts:
  # The list is shopping's.
  - { id: list, kind: context, label: "${label}", ref: ${ref} }
  - { id: plan, kind: ai, label: "Plan the week's dinners" }
lines:
  - { from: list, to: plan, kind: data }
`;

async function push(owner: string, slug: string, as: Who, workflow: string, visibility?: "public" | "private") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, {
    as,
    json: { workflow, ...(visibility ? { visibility } : {}) },
  });
  return { status: res.status, body: await res.json() };
}

async function pushed(owner: string, slug: string, as: Who, workflow: string, visibility?: "public" | "private") {
  const res = await push(owner, slug, as, workflow, visibility);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function stored(owner: string, slug: string, as?: Who) {
  const res = await request("GET", `/api/v1/${owner}/${slug}/v/1`, { as });
  return (await res.json()).files.workflow as string;
}

const checksTab = (owner: string, slug: string, as?: Who) =>
  renderPage(WorkflowChecksPage, { owner, slug }, { as: as?.cookie ? { cookie: as.cookie } : undefined });

// Ana owns acme, with Mo as a member; Bea owns beta, and Mo belongs to it too.
// Nell belongs to nothing.
async function world() {
  const ana = await person("ana");
  const mo = await person("mo");
  const bea = await person("bea");
  const nell = await person("nell");
  await orgWith("acme", ana, [mo]);
  await orgWith("beta", bea, [mo]);
  return { ana, mo, bea, nell };
}

describe("a path ref, rewritten on publish", () => {
  it("is stored as owner/slug#id, the owner pushed to and the file's stem, and the push says so", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    const answer = await pushed("acme", "dinners", { token: ana.token }, dinners("shopping.yaml#list"), "public");
    expect(answer.rewrites).toEqual([{ part: "list", from: "shopping.yaml#list", to: "acme/shopping#list" }]);
    // Only the ref changes: the comment and the rest of the file are as pushed.
    expect(await stored("acme", "dinners")).toBe(dinners("acme/shopping#list"));
  });

  it("keeps the quotes a ref was written in", async () => {
    const { ana } = await world();
    await pushed("ana", "shopping", { token: ana.token }, shopping());
    await pushed("ana", "dinners", { token: ana.token }, dinners(`"shopping.yaml#list"`));
    expect(await stored("ana", "dinners")).toBe(dinners(`"ana/shopping#list"`));
  });

  it("answers a push with no path refs with no rewrites, and leaves an owner/slug#id ref alone", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    const answer = await pushed("acme", "dinners", { token: ana.token }, dinners("acme/shopping#list"));
    expect(answer.rewrites).toEqual([]);
    expect(await stored("acme", "dinners")).toBe(dinners("acme/shopping#list"));
  });

  it("refuses a path that leaves the folder, or isn't a .yaml name, with a 422 naming the ref", async () => {
    const { ana } = await world();
    for (const ref of ["../shopping.yaml#list", "lists/shopping.yaml#list", "shopping.txt#list", "Shopping.yaml#list"]) {
      const res = await push("acme", "dinners", { token: ana.token }, dinners(ref), "private");
      expect(res.status, ref).toBe(422);
      expect(res.body.errors[0]).toContain(`part "list"`);
      expect(res.body.errors[0]).toContain(ref);
    }
    expect((await request("GET", "/api/v1/acme/dinners", { as: { token: ana.token } })).status).toBe(404);
  });

  it("tells the MCP publish tool the rewrites it made", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    const done = await call(
      "publish",
      { owner: "acme", slug: "dinners", workflow: dinners("shopping.yaml#list") },
      ana.token,
    );
    expect(done.isError).toBe(false);
    expect(done.text).toContain("shopping.yaml#list to acme/shopping#list");
    expect(done.data).toMatchObject({ rewrites: [{ part: "list", from: "shopping.yaml#list", to: "acme/shopping#list" }] });
  });
});

describe("checking refs against what they name", () => {
  it("refuses a push whose copy disagrees with the part it refers to, or names a part that isn't there", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    const disagrees = await push("acme", "dinners", { token: ana.token }, dinners("acme/shopping#list", "The list"));
    expect(disagrees.status).toBe(422);
    expect(disagrees.body.errors).toEqual([
      'workflow: part "list" refers to acme/shopping#list, but its label is "The list" here and "Shopping list" there',
    ]);
    const missing = await push("acme", "dinners", { token: ana.token }, dinners("acme/shopping#basket"));
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0]).toContain('acme/shopping has no part "basket"');
  });

  it("reports on the Checks tab a copy that disagrees once the workflow it names changes, and still draws it", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    await pushed("acme", "dinners", { token: ana.token }, dinners("acme/shopping#list"), "public");
    const before = await checksTab("acme", "dinners");
    expect(before.html).toMatch(/data-check="refs.agree"[\s\S]*?Passed/);
    await pushed("acme", "shopping", { token: ana.token }, shopping("The weekly list"));
    const after = await checksTab("acme", "dinners");
    expect(after.html).toContain(
      "part &quot;list&quot; refers to acme/shopping#list, but its label is &quot;Shopping list&quot; here and &quot;The weekly list&quot; there",
    );
    expect(after.html).toContain('<a href="/acme/shopping">acme/shopping</a>#list');
    // The file still checks alone, so its design is still drawn.
    const page = await renderPage(WorkflowPage, { owner: "acme", slug: "dinners" });
    expect(page.html).not.toContain("cannot be drawn");
  });

  it("shows a ref to a workflow not pushed yet as unresolved, until that workflow is pushed", async () => {
    const { ana } = await world();
    await pushed("acme", "dinners", { token: ana.token }, dinners("shopping.yaml#list"), "private");
    const before = await checksTab("acme", "dinners", ana);
    expect(before.html).toContain("acme/shopping#list, not pushed yet");
    await pushed("acme", "shopping", { token: ana.token }, shopping("Another label"), "private");
    const after = await checksTab("acme", "dinners", ana);
    expect(after.html).not.toContain("not pushed yet");
    expect(after.html).toContain('<a href="/acme/shopping">acme/shopping</a>#list');
    expect(after.html).toContain("but its label is &quot;Shopping list&quot; here and &quot;Another label&quot; there");
  });
});

describe("security boundaries", () => {
  it("positive: a private workflow's refs to its owner's private workflows resolve and check", async () => {
    const { ana, mo } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "private");
    // A member pushes it, as an owner may.
    await pushed("acme", "dinners", { token: mo.token }, dinners("shopping.yaml#list"), "private");
    for (const who of [ana, mo]) {
      const tab = await checksTab("acme", "dinners", who);
      expect(tab.html).toContain('<a href="/acme/shopping">acme/shopping</a>#list');
      expect(tab.html).toMatch(/data-check="refs.known"[\s\S]*?Passed/);
    }
    const disagrees = await push("acme", "dinners", { token: mo.token }, dinners("acme/shopping#list", "Other"));
    expect(disagrees.status).toBe(422);
    // A person's own private workflow refers to their own private one too.
    await pushed("ana", "shopping", { token: ana.token }, shopping(), "private");
    await pushed("ana", "dinners", { token: ana.token }, dinners("shopping.yaml#list"), "private");
    expect((await checksTab("ana", "dinners", ana)).html).toContain('<a href="/ana/shopping">ana/shopping</a>#list');
  });

  it("negative: a public push referring to a private workflow, or one that doesn't exist, is refused the same way", async () => {
    const { ana } = await world();
    await pushed("acme", "secret", { token: ana.token }, shopping(), "private");
    const toPrivate = await push("acme", "dinners", { token: ana.token }, dinners("acme/secret#list"), "public");
    const toMissing = await push("acme", "dinners", { token: ana.token }, dinners("acme/nothing#list"), "public");
    expect(toPrivate.status).toBe(422);
    expect(toPrivate.body.errors).toEqual([
      'workflow: part "list" refers to acme/secret#list, but a public workflow may refer only to public ones, and acme/secret is not one.',
    ]);
    expect(toMissing.body.errors[0].replace("nothing", "secret").replace("nothing", "secret")).toBe(
      toPrivate.body.errors[0],
    );
    // A path ref to a file not pushed yet is refused in a public push too.
    const byPath = await push("acme", "dinners", { token: ana.token }, dinners("nothing.yaml#list"), "public");
    expect(byPath.status).toBe(422);
    expect((await request("GET", "/api/v1/acme/dinners")).status).toBe(404);
  });

  it("cross-tenant: a ref to another owner's private workflow reveals nothing, at push or when shown", async () => {
    const { ana, bea, mo } = await world();
    await pushed("acme", "secret", { token: ana.token }, shopping("Acme's own label"), "private");
    // Beta's private push refers to acme's private workflow and to one that doesn't exist: both are
    // taken alike, and neither is checked against, so a copy that would disagree is not refused.
    const toPrivate = await push("beta", "plan", { token: bea.token }, dinners("acme/secret#list", "Guess"), "private");
    const toMissing = await push("beta", "plan2", { token: bea.token }, dinners("acme/nothing#list", "Guess"), "private");
    expect(toPrivate).toEqual({ status: 201, body: expect.objectContaining({ number: 1 }) });
    expect(toMissing.status).toBe(201);
    for (const slug of ["plan", "plan2"]) {
      const tab = await checksTab("beta", slug, bea);
      expect(tab.html).toContain("a workflow you can&#x27;t see");
      expect(tab.html).not.toContain("not pushed yet");
      expect(tab.html).not.toContain("Acme&#x27;s own label");
      expect(tab.html).not.toMatch(/href="\/acme\//);
    }
    // Even pushed by Mo, who belongs to both, beta's workflow is not checked against acme's
    // private one, since beta may not see it.
    const byMo = await push("beta", "plan3", { token: mo.token }, dinners("acme/secret#list", "Guess"), "private");
    expect(byMo.status).toBe(201);
    // Mo may see both, so Mo's Checks tab checks it, and finds the copy disagrees.
    const asMo = await checksTab("beta", "plan", mo);
    expect(asMo.html).toContain('<a href="/acme/secret">acme/secret</a>#list');
    expect(asMo.html).toContain("&quot;Acme&#x27;s own label&quot; there");
  });

  it("cross-tenant: the engine's kept answers for an insider's view never reach an outsider's view of the same tab", async () => {
    const { ana, bea, mo } = await world();
    // Beta's plan refers to acme's private secret and to its public shopping,
    // so everyone who may see the plan has it checked against shopping, and
    // only someone in acme against the secret too. It is pushed before either,
    // so the first time the engine checks it against them is Mo's view.
    const plan = dinners("acme/secret#list", "Guess").replace(
      "  - { id: plan,",
      '  - { id: shop, kind: context, label: "Shopping list", ref: acme/shopping#list }\n  - { id: plan,',
    );
    await pushed("beta", "plan", { token: bea.token }, plan, "private");
    await pushed("acme", "secret", { token: ana.token }, shopping("Acme's own label"), "private");
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    // Mo, in acme and beta, views its Checks tab; then Bea, in beta only, the
    // same tab of the same file; then Mo again.
    const views = [];
    for (const who of [mo, bea, mo]) views.push((await checksTab("beta", "plan", who)).html);
    const [insider, outsider, insiderAgain] = views;
    expect(outsider).toContain('<a href="/acme/shopping">acme/shopping</a>#list');
    expect(outsider).toContain("a workflow you can&#x27;t see");
    expect(outsider).not.toContain("acme/secret");
    expect(outsider).not.toContain("Acme&#x27;s own label");
    expect(outsider).not.toMatch(/href="\/acme\/secret/);
    for (const html of [insider, insiderAgain]) {
      expect(html).toContain('<a href="/acme/secret">acme/secret</a>#list');
      expect(html).toContain("&quot;Acme&#x27;s own label&quot; there");
    }
  });

  it("cross-tenant: Referred to by never lists or counts a referrer the viewer can't see", async () => {
    const { ana, bea, nell } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    await pushed("acme", "dinners", { token: ana.token }, dinners("shopping.yaml#list"), "public");
    await pushed("beta", "hidden-plan", { token: bea.token }, dinners("acme/shopping#list"), "private");
    await pushed("nell", "own-plan", { token: nell.token }, dinners("acme/shopping#list"), "private");
    for (const who of [undefined, ana, nell]) {
      const page = await renderPage(WorkflowPage, { owner: "acme", slug: "shopping" }, { as: who && { cookie: who.cookie } });
      expect(page.html).toContain('<a href="/acme/dinners">acme/dinners</a>');
      expect(page.html).not.toContain("hidden-plan");
      expect(page.html).toMatch(/Referred to by <span[^>]*>(\d)<\/span>/);
      const n = Number(/Referred to by <span[^>]*>(\d)<\/span>/.exec(page.html)![1]);
      expect(n).toBe(who === nell ? 2 : 1);
      expect(page.html.includes("nell/own-plan")).toBe(who === nell);
      const api = await (await request("GET", "/api/v1/acme/shopping", { as: who && { token: who.token } })).json();
      expect(api.referredBy.map((r: { owner: string; slug: string }) => `${r.owner}/${r.slug}`).sort()).toEqual(
        who === nell ? ["acme/dinners", "nell/own-plan"] : ["acme/dinners"],
      );
    }
    const asBea = await (await request("GET", "/api/v1/acme/shopping", { as: { token: bea.token } })).json();
    expect(asBea.referredBy).toContainEqual({
      owner: "beta",
      slug: "hidden-plan",
      title: "Dinners",
      visibility: "private",
      parts: ["list"],
    });
  });

  it("lists the parts each referrer names, and only its latest version's refs", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    await pushed("acme", "dinners", { token: ana.token }, dinners("acme/shopping#list"), "public");
    const page = await renderPage(WorkflowPage, { owner: "acme", slug: "shopping" });
    expect(page.html).toContain('<a href="/acme/dinners">acme/dinners</a><span class="note"> · list</span>');
    await pushed("acme", "dinners", { token: ana.token }, dinners("acme/shopping#list").replace(/, ref: .*? \}/, " }"));
    const later = await renderPage(WorkflowPage, { owner: "acme", slug: "shopping" });
    expect(later.html).not.toContain("Referred to by");
    expect((await (await request("GET", "/api/v1/acme/shopping")).json()).referredBy).toEqual([]);
  });

  it("invalid token: a revoked or made-up token gets the same 401 for a referred public, private and missing workflow", async () => {
    const { ana } = await world();
    await pushed("acme", "shopping", { token: ana.token }, shopping(), "public");
    await pushed("acme", "secret", { token: ana.token }, shopping(), "private");
    const db = await getDb();
    const [made] = await listTokens(db, ana.id);
    await revokeToken(db, ana.id, made.id);
    for (const token of [ana.token, "awml_made_up"]) {
      const answers = [];
      for (const slug of ["shopping", "secret", "nothing"]) {
        const res = await request("GET", `/api/v1/acme/${slug}`, { as: { token } });
        answers.push({ status: res.status, body: await res.text() });
      }
      expect(answers.map((a) => a.status)).toEqual([401, 401, 401]);
      expect(new Set(answers.map((a) => a.body)).size).toBe(1);
      const res = await push("acme", "dinners", { token }, dinners("acme/secret#list"), "private");
      expect(res.status).toBe(401);
    }
  });
});
