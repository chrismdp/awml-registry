// A workflow's "Where it can run" tab (#1): the fit, from AWML's engine,
// against the platforms the viewer may see, in groups: their own private
// platforms, each organisation's they belong to, then the public ones, of
// which at most the 100 newest are judged. Nothing private reaches anyone
// who may not see it, and no other tab runs a fit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { insertRows } from "@/db/rows";
import { platform, platformVersion } from "@/db/schema";
import { engine } from "@/engine";
import { findOwner } from "@/server/owners";
import { PUBLIC_JUDGED } from "@/server/platforms";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowSecurityPage from "@/app/[owner]/[slug]/security/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import WorkflowFitPage from "@/app/[owner]/[slug]/fit/page";
import VersionFitPage from "@/app/[owner]/[slug]/v/[n]/fit/page";
import { example, orgWith, person, request, type Who } from "./helpers";
import { renderPage } from "./pages";

afterEach(() => vi.restoreAllMocks());

const clientEmail = example("client-email.yaml");
const fitsAll = (id: string, label: string) => `awml: "0.11"
platform: { id: ${id}, label: "${label}" }
off_for_up_to: PT0S
steps: code
agents: []
calls: [anthropic]
holds: [notes]
`;
const recipe = "# Install it\n\n1. Copy the workflow's code across.\n";
const examples = ["codex-laptop", "cowork-mac-mini", "scripts-mac-mini", "worker"];

// The page's text, with tags as spaces and runs of spaces as one.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function pushPlatform(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, { as, json: body });
  expect(res.status, await res.clone().text()).toBe(201);
}

async function pushWorkflow(owner: string, slug: string, as: Who, workflow: string) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow } });
  expect(res.status, await res.clone().text()).toBe(201);
}

// Ana keeps a private home box on her own account, with a recipe; Acme,
// Olive's, with Ana as a member, keeps a private back office; Beta, Bea's,
// keeps a private vault and AWML's four example platforms, public. Each
// private platform would fit the client's email, so a page that judged one
// would show it. Nell belongs to nothing, and publishes the client's email.
async function registry() {
  const ana = await person("ana");
  const olive = await person("olive");
  const bea = await person("bea");
  const nell = await person("nell");
  await orgWith("acme", olive, [ana]);
  await orgWith("beta", bea);
  await pushPlatform(ana.username, "home-box", { token: ana.token }, {
    description: fitsAll("home-box", "Ana's home box"),
    recipe,
    visibility: "private",
  });
  await pushPlatform("acme", "back-office", { token: olive.token }, {
    description: fitsAll("back-office", "Acme's back office"),
    visibility: "private",
  });
  await pushPlatform("beta", "vault", { token: bea.token }, {
    description: fitsAll("beta-vault", "Beta's vault server"),
    visibility: "private",
  });
  for (const id of examples) await pushPlatform("beta", id, { token: bea.token }, { description: example(`platforms/${id}.yaml`) });
  await pushWorkflow(nell.username, "client-email", { token: nell.token }, clientEmail);
  return { ana, olive, bea, nell };
}

const fitTab = (owner: string, as?: Who) => renderPage(WorkflowFitPage, { owner, slug: "client-email" }, { as });

describe("the Where it can run tab", () => {
  it("shows a person their own platforms, then each organisation's, then the public ones, with the headline counting what they may see", async () => {
    const { ana, nell } = await registry();
    const page = await fitTab(nell.username, { cookie: ana.cookie });
    expect(page.status).toBe(200);
    const shown = text(page.html);
    expect(shown).toContain("Fits 3 of the 6 platforms you can see");
    const groups = ["Your platforms", "acme's platforms", "Public platforms"].map((g) => shown.indexOf(g));
    expect(groups.every((at) => at >= 0)).toBe(true);
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(shown).toContain("Ana's home box");
    expect(page.html).toContain(`href="/${ana.username}/platforms/home-box"`);
    expect(page.html).toContain(`href="/${ana.username}/platforms/home-box/recipe"`);
    expect(shown).toContain("How to install it here");
    expect(shown).toContain("Acme's back office");
    expect(shown).toContain("choose, draft and learn may use anthropic.");
    expect(shown).toContain("1 of the 4 fits. Closest first.");
    for (const secret of ["vault", "Beta's vault server"]) expect(shown).not.toContain(secret);
  });

  it("gives an organisation's member its private platforms and never another person's own", async () => {
    const { olive, nell } = await registry();
    const shown = text((await fitTab(nell.username, { cookie: olive.cookie })).html);
    expect(shown).toContain("Fits 2 of the 5 platforms you can see");
    expect(shown).toContain("acme's platforms");
    expect(shown).not.toContain("Your platforms");
    for (const secret of ["home-box", "Ana's home box", "vault", "Beta's vault server"]) expect(shown).not.toContain(secret);
  });

  it("gives a stranger and someone signed out the public platforms alone, counting only them", async () => {
    const { bea, nell } = await registry();
    for (const as of [{ cookie: nell.cookie }, undefined]) {
      const page = await fitTab(nell.username, as);
      const shown = text(page.html);
      expect(shown).toContain("Fits 1 of the 4 platforms you can see");
      expect(shown).not.toContain("Your platforms");
      expect(shown).not.toContain("'s platforms");
      for (const secret of ["home-box", "Ana's home box", "back-office", "Acme's back office", "vault", "Beta's vault server"])
        expect(shown).not.toContain(secret);
    }
    expect(text((await fitTab(nell.username)).html)).toContain("Sign in to check your own platforms");
    expect(text((await fitTab(nell.username, { cookie: nell.cookie })).html)).not.toContain("Sign in");
    // Beta's own member sees Beta's private vault, which is no one else's.
    expect(text((await fitTab(nell.username, { cookie: bea.cookie })).html)).toContain("Beta's vault server");
  });

  it("orders the public platforms closest first, each that doesn't fit with how many things are missing and what they are", async () => {
    const { nell } = await registry();
    const shown = text((await fitTab(nell.username)).html);
    const order = ["Scheduled scripts on a Mac mini", "Claude Cowork on a Mac mini", "Codex on a laptop", "A code worker"].map((l) =>
      shown.indexOf(l),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(shown).toContain("1 thing missing");
    expect(shown).toContain("bring, rules and save are code steps, which anthropic's agent would carry out");
    expect(shown).toContain("2 things missing");
  });

  it("is at the version's own address too, and a 404 for a workflow the viewer may not see", async () => {
    const { ana, nell } = await registry();
    const version = await renderPage(VersionFitPage, { owner: nell.username, slug: "client-email", n: "1" });
    expect([version.status, text(version.html).includes("Fits 1 of the 4 platforms you can see")]).toEqual([200, true]);
    await request("POST", `/api/v1/${ana.username}/diary/versions`, {
      as: { token: ana.token },
      json: { workflow: clientEmail, visibility: "private" },
    });
    for (const as of [{ cookie: nell.cookie }, undefined])
      for (const slug of ["diary", "nothing-here"])
        expect((await renderPage(WorkflowFitPage, { owner: ana.username, slug }, { as })).status).toBe(404);
    expect((await renderPage(WorkflowFitPage, { owner: ana.username, slug: "diary" }, { as: { cookie: ana.cookie } })).status).toBe(200);
  });
});

describe("the tab's label and what the other tabs cost", () => {
  it("counts the platforms that fit on the open tab alone, and the other tabs run no fit", async () => {
    const { ana, nell } = await registry();
    const fit = vi.spyOn(engine, "fit");
    const owner = nell.username;
    for (const Page of [WorkflowPage, WorkflowSecurityPage, WorkflowPlatformPage, WorkflowYamlPage, WorkflowChecksPage]) {
      const page = await renderPage(Page, { owner, slug: "client-email" }, { as: { cookie: ana.cookie } });
      expect(page.status).toBe(200);
      expect(page.html).toMatch(/<a [^>]*href="\/[^"]+\/client-email\/fit"[^>]*>Where it can run<\/a>/);
    }
    expect(fit).not.toHaveBeenCalled();
    const open = await fitTab(owner, { cookie: ana.cookie });
    expect(open.html).toMatch(/aria-selected="true"[^>]*>Where it can run<span class="tab-count">3<\/span><\/a>/);
    expect(fit).toHaveBeenCalled();
  });

  it("carries no count when nothing fits", async () => {
    const nell = await person("nell");
    const bea = await person("bea");
    await pushPlatform(bea.username, "worker", { token: bea.token }, { description: example("platforms/worker.yaml") });
    await pushWorkflow(nell.username, "client-email", { token: nell.token }, clientEmail);
    const page = await fitTab(nell.username);
    expect(text(page.html)).toContain("Fits 0 of the 1 platform you can see");
    expect(page.html).toMatch(/aria-selected="true"[^>]*>Where it can run<\/a>/);
  });

  it("claims no count in the headline when the fit can't judge the workflow", async () => {
    const nell = await person("nell");
    const bea = await person("bea");
    await pushPlatform(bea.username, "worker", { token: bea.token }, { description: example("platforms/worker.yaml") });
    await pushWorkflow(nell.username, "client-email", { token: nell.token }, example("dinners.yaml"));
    const shown = text((await fitTab(nell.username)).html);
    expect(shown).toContain("This workflow doesn't say all the fit needs");
    expect(shown).toContain("The fit can't judge it yet against the 1 platform you can see");
    expect(shown).not.toContain("Fits 0");
  });
});

describe("the bound on public platforms", () => {
  // Bea's public workers, made straight in the database, each a code worker
  // under its own id, a minute apart, the last the newest. None holds the
  // client's notes, so every one has the same two reasons.
  async function workers(count: number) {
    const db = await getDb();
    const bea = await person("bea");
    const nell = await person("nell");
    const start = Date.UTC(2026, 10, 1);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `worker-${i}`,
      ownerUserId: bea.id,
      slug: `worker-${String(i).padStart(3, "0")}`,
      label: `Worker ${i}`,
      visibility: "public" as const,
      createdAt: new Date(start + i * 60_000),
      updatedAt: new Date(start + i * 60_000),
    }));
    await insertRows(db, platform, rows);
    await insertRows(
      db,
      platformVersion,
      rows.map((r) => ({
        platformId: r.id,
        number: 1,
        pushedBy: bea.id,
        description: example("platforms/worker.yaml").replace("id: worker", `id: ${r.slug}`).replace('"A code worker"', `"${r.label}"`),
      })),
    );
    await pushWorkflow(nell.username, "client-email", { token: nell.token }, clientEmail);
    expect(await findOwner(db, bea.username)).not.toBeNull();
    return { bea, nell };
  }

  it("judges no more than the 100 newest public platforms, and says so", async () => {
    expect(PUBLIC_JUDGED).toBe(100);
    const { nell } = await workers(105);
    const fit = vi.spyOn(engine, "fit");
    const page = await fitTab(nell.username);
    expect(fit).toHaveBeenCalledTimes(100);
    const shown = text(page.html);
    expect(shown).toContain("Fits 0 of the 105 platforms you can see, judged against the 100 newest public ones");
    expect(shown).toContain("Worker 104");
    expect(shown).toContain("Worker 5 ");
    expect(shown).not.toContain("Worker 4 ");
    expect(page.html).not.toContain("worker-004");
  });

  it("shows five, then the rest behind Show N more, and a reason every public platform shares once", async () => {
    const { nell } = await workers(8);
    const page = await fitTab(nell.username);
    const shown = text(page.html);
    expect(shown).toContain("None of the 8 fits. Closest first.");
    expect(shown).toContain("Missing from every public platform, and not repeated below");
    expect(shown.match(/engagements is kept at notes\/engagements, which the platform doesn't hold/g)).toHaveLength(1);
    expect(shown.match(/2 things missing/g)).toHaveLength(8);
    expect(shown.match(/Nothing else is missing\./g)).toHaveLength(8);
    expect(page.html).toMatch(/<details[^>]*><summary[^>]*>Show 3 more<\/summary>/);
    // Ties are ordered by owner/slug.
    const order = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => shown.indexOf(`Worker ${i} `));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("Placed in this workflow", () => {
  // The client's email with its Mac mini block placed on a registered platform.
  const placedOn = (address: string) =>
    clientEmail.replace(
      '{ id: cowork, label: "Claude Cowork, Mac mini", parts',
      `{ id: cowork, label: "Claude Cowork, Mac mini", platform: ${address}, parts`,
    );

  it("says whether each implementation's placement on a registered platform fits", async () => {
    const { ana, nell } = await registry();
    await pushWorkflow(nell.username, "placed", { token: nell.token }, placedOn("acme/platforms/back-office"));
    const page = await renderPage(WorkflowFitPage, { owner: nell.username, slug: "placed" }, { as: { cookie: ana.cookie } });
    const shown = text(page.html);
    expect(shown).toContain("Placed in this workflow");
    expect(shown).toContain(
      "The consultant's office puts Claude Cowork, Mac mini on acme/platforms/back-office , and that placement fits.",
    );
    expect(page.html).toContain('href="/acme/platforms/back-office"');
  });

  it("answers a placement on a platform the viewer can't see as it answers one on a missing platform", async () => {
    const { nell } = await registry();
    await pushWorkflow(nell.username, "placed", { token: nell.token }, placedOn("acme/platforms/back-office"));
    await pushWorkflow(nell.username, "missing", { token: nell.token }, placedOn("acme/platforms/nothing-here"));
    for (const as of [{ cookie: nell.cookie }, undefined]) {
      const placed = await renderPage(WorkflowFitPage, { owner: nell.username, slug: "placed" }, { as });
      const missing = await renderPage(WorkflowFitPage, { owner: nell.username, slug: "missing" }, { as });
      const panel = (html: string) => html.slice(html.indexOf("Placed in this workflow"));
      expect(panel(placed.html)).toContain("acme/platforms/back-office");
      expect(panel(placed.html).replaceAll("back-office", "nothing-here")).toBe(panel(missing.html).replaceAll("/placed", "/missing"));
      expect(placed.html).not.toContain("Acme&#x27;s back office");
    }
  });

  it("is left out when no block names a registered platform", async () => {
    const { nell } = await registry();
    expect(text((await fitTab(nell.username)).html)).not.toContain("Placed in this workflow");
  });
});
