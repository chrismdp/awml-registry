// The data the build workflow puts in a fresh registry before it pictures its pages:
// scripts/seed-pictures.ts, run here through the app's own route handlers as the workflow runs
// it over HTTP. If a change to the API breaks the seed, this fails in CI, not in a build's
// pictures.
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { findOwner } from "@/server/owners";
import { listMembers } from "@/server/organisations";
import SystemPage from "@/app/[owner]/systems/[slug]/page";
import { seed } from "../scripts/seed-pictures";
import { BASE, request, sentEmails } from "./helpers";
import { renderPage } from "./pages";
import { route } from "./router";

async function signInLink(email: string) {
  const sent = sentEmails.findLast((e) => e.to === email);
  if (!sent) throw new Error(`no sign-in link went to ${email}`);
  return sent.url;
}

const seeded = () => seed({ base: BASE, send: route, signInLink });

async function read(path: string, cookie?: string) {
  const res = await request("GET", path, { as: cookie ? { cookie } : undefined });
  return { status: res.status, body: res.ok ? await res.json() : undefined };
}

describe("seeding a registry for the build's pictures", () => {
  it("signs ana in and hands back her session", async () => {
    const { cookie } = await seeded();
    const res = await request("PATCH", "/api/v1/me", { as: { cookie }, json: { username: "ana" } });
    expect(res.status).toBe(200);
    expect((await res.json()).username).toBe("ana");
  });

  it("makes acme, owned by ana, with ben as a member", async () => {
    await seeded();
    const acme = await findOwner(await getDb(), "acme");
    expect(acme?.type).toBe("organisation");
    const members = await listMembers(await getDb(), acme!.id);
    expect(members.map((m) => [m.username, m.role])).toEqual([
      ["ana", "owner"],
      ["ben", "member"],
    ]);
  });

  it("pushes acme's public workflows, with dinners at two versions", async () => {
    await seeded();
    const dinners = await read("/api/v1/acme/dinners");
    expect(dinners.body).toMatchObject({ title: "The family's dinners", visibility: "public" });
    expect(dinners.body.versions).toHaveLength(2);
    const email = await read("/api/v1/acme/client-email");
    expect(email.body).toMatchObject({ visibility: "public" });
    expect(email.body.versions).toHaveLength(1);
  });

  it("keeps ana's own dinners private: a visitor gets a 404, ana sees it", async () => {
    const { cookie } = await seeded();
    expect((await read("/api/v1/ana/dinners")).status).toBe(404);
    expect((await read("/api/v1/ana/dinners", cookie)).body).toMatchObject({ visibility: "private" });
  });

  it("forks acme/dinners at version 1 to ana/family-dinners, so a fork and the original's forks show", async () => {
    await seeded();
    const fork = await read("/api/v1/ana/family-dinners");
    expect(fork.body).toMatchObject({ visibility: "public", forkedFrom: { owner: "acme", slug: "dinners", number: 1 } });
  });

  it("pushes acme/shopping, whose path ref to dinners.yaml is stored naming acme/dinners, so dinners lists it", async () => {
    await seeded();
    const shopping = await read("/api/v1/acme/shopping/v/1");
    expect(shopping.body.visibility).toBe("public");
    expect(shopping.body.files.workflow).toContain("ref: acme/dinners#favourites");
    const dinners = await read("/api/v1/acme/dinners");
    expect(dinners.body.referredBy).toContainEqual({
      owner: "acme",
      slug: "shopping",
      title: "The family's shopping",
      visibility: "public",
      parts: ["favourites"],
    });
  });

  it("pushes acme/pantry, referring to the same part, so dinners' favourites lead to two workflows", async () => {
    await seeded();
    const pantry = await read("/api/v1/acme/pantry/v/1");
    expect(pantry.body.visibility).toBe("public");
    expect(pantry.body.files.workflow).toContain("ref: acme/dinners#favourites");
    const dinners = await read("/api/v1/acme/dinners");
    expect(dinners.body.referredBy).toEqual([
      { owner: "acme", slug: "pantry", title: "The family's pantry", visibility: "public", parts: ["favourites"] },
      { owner: "acme", slug: "shopping", title: "The family's shopping", visibility: "public", parts: ["favourites"] },
    ]);
  });

  it("pushes acme/systems/kitchen, public, holding acme's private cupboards, which a visitor sees only counted", async () => {
    const { cookie } = await seeded();
    expect((await read("/api/v1/acme/cupboards")).status).toBe(404);
    expect((await read("/api/v1/acme/cupboards", cookie)).body).toMatchObject({ visibility: "private" });
    const toVisitor = await renderPage(SystemPage, { owner: "acme", slug: "kitchen" });
    expect(toVisitor.status).toBe(200);
    expect(toVisitor.html).toContain("<h1>The family&#x27;s kitchen</h1>");
    expect(toVisitor.html).toContain('href="/acme/dinners"');
    expect(toVisitor.html).toContain('href="/acme/shopping"');
    expect(toVisitor.html).toContain("1 private workflow");
    expect(toVisitor.html).toContain('<svg class="flow-static"');
    expect(toVisitor.html).not.toContain("acme/cupboards");
    expect(toVisitor.html).not.toContain("The family&#x27;s cupboards");
    const toAna = await renderPage(SystemPage, { owner: "acme", slug: "kitchen" }, { as: { cookie } });
    expect(toAna.html).toContain('href="/acme/cupboards"');
    expect(toAna.html).toContain("The family&#x27;s cupboards");
    expect(toAna.html).not.toContain("private workflow");
    expect(toAna.html).not.toContain("not drawn");
  });

  it("pushes acme's platforms, the worker at two versions with its recipe and one kept private", async () => {
    const { cookie } = await seeded();
    const worker = await read("/api/v1/acme/platforms/worker");
    expect(worker.body).toMatchObject({ label: "A code worker", visibility: "public" });
    expect(worker.body.recipe).toContain("# Install on a code worker");
    expect(worker.body.versions).toHaveLength(2);
    expect((await read("/api/v1/acme/platforms/codex-laptop")).status).toBe(200);
    expect((await read("/api/v1/acme/platforms/cowork-mac-mini")).status).toBe(404);
    expect((await read("/api/v1/acme/platforms/cowork-mac-mini", cookie)).status).toBe(200);
  });
});
