// A platform's "Workflows that fit" tab (#125): the workflows the viewer may
// see whose design the platform holds, judged by AWML's engine, in groups:
// their own private workflows, each organisation's they belong to, then the
// public ones, of which at most the 100 newest are judged. Nothing private
// reaches anyone who may not see it, and no other tab runs a fit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { insertRows } from "@/db/rows";
import { auditEvent, version, workflow } from "@/db/schema";
import { engine } from "@/engine";
import { PUBLIC_JUDGED } from "@/server/platforms";
import PlatformPage from "@/app/[owner]/platforms/[slug]/page";
import PlatformRecipePage from "@/app/[owner]/platforms/[slug]/recipe/page";
import PlatformYamlPage from "@/app/[owner]/platforms/[slug]/yaml/page";
import PlatformWorkflowsPage from "@/app/[owner]/platforms/[slug]/workflows/page";
import PlatformVersionWorkflowsPage from "@/app/[owner]/platforms/[slug]/v/[n]/workflows/page";
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

async function pushWorkflow(owner: string, slug: string, as: Who, file: string, visibility: "public" | "private" = "public") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: { workflow: file, visibility } });
  expect(res.status, await res.clone().text()).toBe(201);
}

const titled = (title: string) => clientEmail.replace("title: A client's email, answered with a draft", `title: ${title}`);

// Nell keeps a public open box, which holds the client's email. Ana keeps her
// diary private on her own account; Acme, Olive's, with Ana as a member,
// keeps its office mail private; Beta, Bea's, keeps its vault mail private.
// Each private workflow would fit, so a page that judged one would show it.
// Nell publishes the client's email, which fits, and the dinners, which the
// fit can't judge.
async function registry() {
  const ana = await person("ana");
  const olive = await person("olive");
  const bea = await person("bea");
  const nell = await person("nell");
  await orgWith("acme", olive, [ana]);
  await orgWith("beta", bea);
  await pushPlatform(nell.username, "open-box", { token: nell.token }, { description: fitsAll("open-box", "Nell's open box") });
  await pushWorkflow(ana.username, "diary", { token: ana.token }, titled("Ana's diary"), "private");
  await pushWorkflow("acme", "office-mail", { token: olive.token }, titled("Acme's office mail"), "private");
  await pushWorkflow("beta", "vault-mail", { token: bea.token }, titled("Beta's vault mail"), "private");
  await pushWorkflow(nell.username, "client-email", { token: nell.token }, clientEmail);
  await pushWorkflow(nell.username, "dinners", { token: nell.token }, example("dinners.yaml"));
  return { ana, olive, bea, nell };
}

const tab = (owner: string, as?: Who, slug = "open-box") => renderPage(PlatformWorkflowsPage, { owner, slug }, { as });

const secrets = {
  ana: ["Ana's diary", "/diary"],
  acme: ["Acme's office mail", "office-mail"],
  beta: ["Beta's vault mail", "vault-mail"],
};

describe("the Workflows that fit tab", () => {
  it("shows a person their own workflows, then each organisation's, then the public ones, counting what they may see", async () => {
    const { ana, nell } = await registry();
    const page = await tab(nell.username, { cookie: ana.cookie });
    expect(page.status).toBe(200);
    const shown = text(page.html);
    expect(shown).toContain("3 of the 4 workflows you can see fit here");
    const groups = ["Your workflows", "acme's workflows", "Public workflows"].map((g) => shown.indexOf(g));
    expect(groups.every((at) => at >= 0)).toBe(true);
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(page.html).toContain(`href="/${ana.username}/diary"`);
    expect(page.html).toContain('href="/acme/office-mail"');
    expect(page.html).toContain(`href="/${nell.username}/client-email"`);
    expect(shown).toContain(`${nell.username}/client-email · v1`);
    expect(shown).toContain("choose, draft and learn may use anthropic.");
    expect(shown).toContain("1 of the 2 public workflows fits.");
    // The dinners can't be judged, so they are counted but not listed.
    expect(shown).not.toContain("The family's dinners");
    for (const secret of secrets.beta) expect(shown).not.toContain(secret);
  });

  it("gives an organisation's member its private workflows and never another person's own", async () => {
    const { olive, nell } = await registry();
    const shown = text((await tab(nell.username, { cookie: olive.cookie })).html);
    expect(shown).toContain("2 of the 3 workflows you can see fit here");
    expect(shown).toContain("acme's workflows");
    expect(shown).not.toContain("Your workflows");
    for (const secret of [...secrets.ana, ...secrets.beta]) expect(shown).not.toContain(secret);
  });

  it("gives a stranger and someone signed out the public workflows alone, counting only them", async () => {
    const { bea, nell } = await registry();
    for (const as of [{ cookie: nell.cookie }, undefined]) {
      const shown = text((await tab(nell.username, as)).html);
      expect(shown).toContain("1 of the 2 workflows you can see fits here");
      expect(shown).not.toContain("Your workflows");
      expect(shown).not.toContain("'s workflows");
      for (const secret of [...secrets.ana, ...secrets.acme, ...secrets.beta]) expect(shown).not.toContain(secret);
    }
    expect(text((await tab(nell.username)).html)).toContain("Sign in to check your own workflows and your organisations'");
    expect(text((await tab(nell.username, { cookie: nell.cookie })).html)).not.toContain("Sign in");
    // Beta's own member sees Beta's private vault mail, which is no one else's.
    expect(text((await tab(nell.username, { cookie: bea.cookie })).html)).toContain("Beta's vault mail");
  });

  it("says when none of a group fits, and lists nothing that doesn't", async () => {
    const nell = await person("nell");
    await pushPlatform(nell.username, "worker", { token: nell.token }, { description: example("platforms/worker.yaml") });
    await pushWorkflow(nell.username, "client-email", { token: nell.token }, clientEmail);
    const shown = text((await tab(nell.username, undefined, "worker")).html);
    expect(shown).toContain("0 of the 1 workflow you can see fit here");
    expect(shown).toContain("The one public workflow doesn't fit.");
    expect(shown).not.toContain("A client's email, answered with a draft");
  });

  it("is at the version's own address too, judging that version, and a 404 for a platform the viewer may not see", async () => {
    const { ana, nell } = await registry();
    await pushPlatform(nell.username, "open-box", { token: nell.token }, { description: example("platforms/worker.yaml") });
    const first = await renderPage(PlatformVersionWorkflowsPage, { owner: nell.username, slug: "open-box", n: "1" });
    expect([first.status, text(first.html).includes("1 of the 2 workflows you can see fits here")]).toEqual([200, true]);
    expect(text((await tab(nell.username)).html)).toContain("0 of the 2 workflows you can see fit here");
    await pushPlatform(ana.username, "home-box", { token: ana.token }, {
      description: fitsAll("home-box", "Ana's home box"),
      visibility: "private",
    });
    for (const as of [{ cookie: nell.cookie }, undefined])
      for (const slug of ["home-box", "nothing-here"]) {
        expect((await tab(ana.username, as, slug)).status).toBe(404);
        expect((await renderPage(PlatformVersionWorkflowsPage, { owner: ana.username, slug, n: "1" }, { as })).status).toBe(404);
      }
    expect((await tab(ana.username, { cookie: ana.cookie }, "home-box")).status).toBe(200);
  });

  it("is a tab beside the others, and no other tab runs a fit", async () => {
    const { ana, nell } = await registry();
    const fit = vi.spyOn(engine, "fit");
    for (const Page of [PlatformPage, PlatformRecipePage, PlatformYamlPage]) {
      const page = await renderPage(Page, { owner: nell.username, slug: "open-box" }, { as: { cookie: ana.cookie } });
      expect(page.html).toMatch(/<a [^>]*href="\/[^"]+\/platforms\/open-box\/workflows"[^>]*>Workflows that fit<\/a>/);
    }
    expect(fit).not.toHaveBeenCalled();
    const open = await tab(nell.username, { cookie: ana.cookie });
    expect(open.html).toMatch(/aria-selected="true"[^>]*>Workflows that fit<\/a>/);
    expect(fit).toHaveBeenCalled();
  });

  it("records no view of a private workflow it lists", async () => {
    const { ana, nell } = await registry();
    await tab(nell.username, { cookie: ana.cookie });
    const rows = await (await getDb()).select().from(auditEvent).where(eq(auditEvent.action, "private_view"));
    expect(rows).toEqual([]);
  });
});

describe("the bound on public workflows", () => {
  // Nell's public copies of the client's email, made straight in the
  // database, a minute apart, the last the newest. Each fits the open box.
  async function copies(count: number) {
    const db = await getDb();
    const nell = await person("nell");
    await pushPlatform(nell.username, "open-box", { token: nell.token }, { description: fitsAll("open-box", "Nell's open box") });
    await pushWorkflow(nell.username, "seed", { token: nell.token }, clientEmail, "private");
    const [seed] = await db.select().from(version);
    const start = Date.UTC(2026, 10, 1);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `copy-${i}`,
      ownerUserId: nell.id,
      slug: `copy-${String(i).padStart(3, "0")}`,
      title: `Copy ${i}`,
      visibility: "public" as const,
      createdAt: new Date(start + i * 60_000),
      updatedAt: new Date(start + i * 60_000),
    }));
    await insertRows(db, workflow, rows);
    await insertRows(
      db,
      version,
      rows.map((r) => ({
        workflowId: r.id,
        number: 1,
        pushedBy: nell.id,
        workflow: clientEmail.replace("title: A client's email, answered with a draft", `title: ${r.title}`),
        check: seed.check,
        checks: seed.checks,
        summary: seed.summary,
      })),
    );
    return { nell };
  }

  it("judges no more than the 100 newest public workflows, and says so", async () => {
    expect(PUBLIC_JUDGED).toBe(100);
    await copies(105);
    const fit = vi.spyOn(engine, "fit");
    const page = await tab("nell");
    expect(fit).toHaveBeenCalledTimes(100);
    const shown = text(page.html);
    expect(shown).toContain("100 of the 105 workflows you can see fit here, judged against the 100 newest public ones");
    expect(shown).toContain("100 of the 100 newest public workflows fit.");
    expect(shown).not.toContain("Copy 4 ");
    expect(page.html).not.toContain("copy-004");
  });

  it("shows 20 of a group, newest first, with a count of the rest", async () => {
    await copies(25);
    const shown = text((await tab("nell")).html);
    expect(shown).toContain("25 of the 25 public workflows fit.");
    expect(shown.match(/nell\/copy-\d+ · v1/g)).toHaveLength(20);
    expect(shown).toContain("5 more fit.");
    const order = [24, 23, 22, 5].map((i) => shown.indexOf(`Copy ${i} `));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(shown).not.toContain("Copy 4 ");
  });
});
