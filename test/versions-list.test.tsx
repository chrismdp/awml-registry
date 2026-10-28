// The Versions list on a workflow's page and a platform's page, which the
// header's "Version n of m" opens: each version on one line, as
// "#8 · chrismdp · Today 4:43pm · 0.7".
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { platformVersion, version } from "@/db/schema";
import { ukTime } from "@/server/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import VersionPlatformPage from "@/app/[owner]/[slug]/v/[n]/platform/page";
import VersionSecurityPage from "@/app/[owner]/[slug]/v/[n]/security/page";
import ImplementationPage from "@/app/[owner]/[slug]/v/[n]/platform/[implementation]/page";
import PlatformPage from "@/app/[owner]/platforms/[slug]/page";
import PlatformRecipePage from "@/app/[owner]/platforms/[slug]/recipe/page";
import PlatformVersionPage from "@/app/[owner]/platforms/[slug]/v/[n]/page";
import PlatformVersionYamlPage from "@/app/[owner]/platforms/[slug]/v/[n]/yaml/page";
import { closesOn, VersionsDialog } from "@/components/VersionPicker";
import { example, orgWith, person, request, storePlatformVersion, storeVersion, type Who } from "./helpers";
import { renderPage } from "./pages";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// The page's header, and the column beside its content.
const headOf = (html: string) => html.split('<section class="wf-head">')[1].split("</section>")[0];
const asideOf = (html: string) => /<aside>([^]*?)<\/aside>/.exec(html)?.[1] ?? "";

// Each line of the Versions list in the header, as text, and the list's markup.
const versionsOf = (html: string) => {
  const list = /<ol class="versions">([^]*?)<\/ol>/.exec(headOf(html))?.[1] ?? "";
  return { html: list, lines: [...list.matchAll(/<li>([^]*?)<\/li>/g)].map(([, li]) => text(li)) };
};

// The address each other version's number links to.
const linksOf = (html: string) =>
  Object.fromEntries([...versionsOf(html).html.matchAll(/<a href="([^"]*)">#(\d+)<\/a>/g)].map(([, href, n]) => [n, href]));

// Sunday 18 October 2026, 09:12 in London (BST), 08:12 UTC.
const OCT_18 = new Date("2026-10-18T08:12:00Z");

describe("when a version was pushed", () => {
  // Thursday 22 October 2026, 16:43 in London (BST).
  const now = new Date("2026-10-22T15:43:00Z");

  it("says Today or Yesterday for those days, in UK time", () => {
    expect(ukTime(new Date("2026-10-22T15:43:00Z"), now)).toBe("Today 4:43pm");
    expect(ukTime(new Date("2026-10-21T23:30:00Z"), now)).toBe("Today 12:30am");
    expect(ukTime(new Date("2026-10-21T08:12:00Z"), now)).toBe("Yesterday 9:12am");
    expect(ukTime(new Date("2026-10-20T22:59:00Z"), now)).toBe("20 Oct 2026, 11:59pm");
  });

  it("gives the date otherwise, with the time in UK time, in winter and summer", () => {
    expect(ukTime(OCT_18, now)).toBe("18 Oct 2026, 9:12am");
    expect(ukTime(new Date("2026-01-05T12:00:00Z"), now)).toBe("5 Jan 2026, 12:00pm");
    expect(ukTime(new Date("2026-09-30T23:05:00Z"), now)).toBe("1 Oct 2026, 12:05am");
    expect(ukTime(new Date("2026-09-02T17:00:00Z"), now)).toBe("2 Sep 2026, 6:00pm");
  });

  it("counts yesterday across the change of the clocks", () => {
    // Monday 26 October 2026, 10:00 GMT; the clocks went back on the Sunday.
    const monday = new Date("2026-10-26T10:00:00Z");
    expect(ukTime(new Date("2026-10-25T00:30:00Z"), monday)).toBe("Yesterday 1:30am");
    expect(ukTime(new Date("2026-10-24T22:30:00Z"), monday)).toBe("24 Oct 2026, 11:30pm");
  });
});

describe("a workflow's Versions list", () => {
  it("shows each version as its number, who pushed it, when, and its AWML", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await storeVersion(o, "dinners", ana, {
      security: example("legacy/dinners-security.yaml"),
      platform: example("legacy/dinners-platform.yaml"),
    });
    await storeVersion(o, "dinners", ana, { security: example("legacy/client-email-security.yaml") });
    const pushed = await request("POST", `/api/v1/${o}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: example("dinners.yaml") },
    });
    expect(pushed.status).toBe(201);
    const db = await getDb();
    await db.update(version).set({ pushedAt: OCT_18 }).where(eq(version.number, 1));

    const latest = versionsOf((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html);
    // Newest first; the one shown is marked Showing, and the newest Latest.
    expect(latest.lines[0]).toMatch(new RegExp(`^#3 · ${o} · Today \\d{1,2}:\\d{2}(am|pm) · 0\\.7 Showing Latest$`));
    expect(latest.lines[1]).toMatch(new RegExp(`^#2 · ${o} · (Today|Yesterday|\\d+ \\w{3} \\d{4},) .* · 0\\.3$`));
    expect(latest.lines[2]).toBe(`#1 · ${o} · 18 Oct 2026, 9:12am · 0.2`);
    // The version shown is bold, not a link; the others link to their pages,
    // and each pusher to their page.
    expect(latest.html).toContain("<strong>#3</strong>");
    expect(latest.html).toContain(`<a href="/${o}/dinners/v/2">#2</a>`);
    expect(latest.html).toContain(`<a href="/${o}/dinners/v/1">#1</a>`);
    expect(latest.html).toContain(`<a href="/${o}">${o}</a>`);

    const old = versionsOf((await renderPage(VersionPage, { owner: o, slug: "dinners", n: "1" })).html);
    expect(old.html).toContain(`<a href="/${o}/dinners">#3</a>`);
    expect(old.html).toContain("<strong>#1</strong>");
    expect(old.lines[0]).toMatch(/ · 0\.7 Latest$/);
    expect(old.lines[2]).toBe(`#1 · ${o} · 18 Oct 2026, 9:12am · 0.2 Showing`);
  });
});

// Ana's dinners at three versions of the one file.
async function threeDinners() {
  const ana = await person("ana");
  for (let i = 0; i < 3; i++) {
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: example("dinners.yaml") },
    });
    expect(res.status).toBe(201);
  }
  return ana.username;
}

describe("the versions in a workflow's header", () => {
  it("are no longer in a box beside the page", async () => {
    const o = await threeDinners();
    for (const html of [
      (await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html,
      (await renderPage(VersionPage, { owner: o, slug: "dinners", n: "1" })).html,
    ]) {
      expect(asideOf(html)).not.toBe("");
      expect(asideOf(html)).not.toContain("Versions");
      expect(asideOf(html)).not.toContain('class="versions"');
      expect(versionsOf(html).lines).toHaveLength(3);
    }
  });

  it("open from the version in the header, and work without JavaScript", async () => {
    const o = await threeDinners();
    const head = headOf((await renderPage(VersionPage, { owner: o, slug: "dinners", n: "2" })).html);
    // As the server sends it, before any script runs: a <details> whose
    // summary is the version and which holds the list.
    expect(text(head)).toContain("Public · Version 2 of 3 #3 ");
    expect(head).toMatch(/<details class="version-pick"><summary>Version 2 of 3<svg[^]*<\/summary>[^]*<ol class="versions">/);
    expect(head).not.toContain("<dialog");
  });

  it("link each other version to the same tab", async () => {
    const o = await threeDinners();
    const at = (n: string) => ({ owner: o, slug: "dinners", n });
    expect(linksOf((await renderPage(VersionChecksPage, at("2"))).html)).toEqual({
      "3": `/${o}/dinners/checks`,
      "1": `/${o}/dinners/v/1/checks`,
    });
    expect(linksOf((await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" })).html)).toEqual({
      "2": `/${o}/dinners/v/2/yaml`,
      "1": `/${o}/dinners/v/1/yaml`,
    });
    expect(linksOf((await renderPage(VersionPlatformPage, at("1"))).html)).toEqual({
      "3": `/${o}/dinners/platform`,
      "2": `/${o}/dinners/v/2/platform`,
    });
    // The page's own address is the security view, so its links leave it off.
    expect(linksOf((await renderPage(VersionSecurityPage, at("2"))).html)).toEqual({
      "3": `/${o}/dinners`,
      "1": `/${o}/dinners/v/1`,
    });
    // An implementation's own address keeps to that implementation.
    const one = await renderPage(ImplementationPage, { ...at("1"), implementation: "home" });
    expect(one.status).toBe(200);
    expect(linksOf(one.html)).toEqual({
      "3": `/${o}/dinners/platform/home`,
      "2": `/${o}/dinners/v/2/platform/home`,
    });
  });

  it("say Version 1 of 1 as plain text when there is only one", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: example("dinners.yaml") },
    });
    expect(res.status).toBe(201);
    const head = headOf((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(text(head)).toMatch(/Public · Version 1 of 1 Fork$/);
    expect(head).not.toMatch(/<details|<button|<dialog|class="versions"/);
  });
});

describe("the Versions dialog, once the page's script runs", () => {
  const dialog = (number: number, latest: number) =>
    renderToStaticMarkup(
      <VersionsDialog number={number} latest={latest}>
        <ol className="versions">
          <li>#1</li>
        </ol>
      </VersionsDialog>,
    );

  it("is opened by a button that reads as the header's version", () => {
    expect(dialog(2, 3)).toMatch(/^<button type="button" class="version-pick" aria-haspopup="dialog">Version 2 of 3<svg[^]*?<\/svg><\/button>/);
  });

  it("is a native dialog titled Versions, with a Close button and the list", () => {
    const html = dialog(2, 3);
    const id = /<dialog class="versions-dialog" aria-labelledby="([^"]+)">/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`<h2 id="${id}">Versions</h2>`);
    expect(html).toContain('<button type="button" class="button">Close</button>');
    expect(html).toContain('<div class="versions-dialog-list"><ol class="versions"><li>#1</li></ol></div>');
  });

  it("closes on a click on its backdrop or on a link in it, not elsewhere inside", () => {
    // The dialog's box fills it, so only a click on the backdrop lands on the dialog itself.
    const box = { closest: () => null };
    const link = { closest: (s: string) => (s === "a" ? link : null) };
    const inside = { closest: () => null };
    expect(closesOn(box, box)).toBe(true);
    expect(closesOn(link, box)).toBe(true);
    expect(closesOn(inside, box)).toBe(false);
    expect(closesOn(null, box)).toBe(false);
  });
});

describe("a platform's Versions list", () => {
  // A 0.5 description stored before the registry took only 0.7, then a 0.7 one pushed.
  async function laptop() {
    const ana = await person("ana");
    const o = ana.username;
    await storePlatformVersion(o, "laptop", ana, example("older/scripts-mac-mini-05.yaml"));
    const res = await request("POST", `/api/v1/platforms/${o}/laptop/versions`, {
      as: { token: ana.token },
      json: { description: example("platforms/worker.yaml") },
    });
    expect(res.status).toBe(201);
    return o;
  }

  it("shows each version the same way, in the header, not beside the page", async () => {
    const o = await laptop();
    const db = await getDb();
    await db.update(platformVersion).set({ pushedAt: OCT_18 }).where(eq(platformVersion.number, 1));

    const page = (await renderPage(PlatformPage, { owner: o, slug: "laptop" })).html;
    expect(asideOf(page)).not.toBe("");
    expect(asideOf(page)).not.toContain("Versions");
    expect(headOf(page)).toMatch(/<details class="version-pick"><summary>Version 2 of 2<svg/);
    const latest = versionsOf(page);
    expect(latest.lines[0]).toMatch(new RegExp(`^#2 · ${o} · Today \\d{1,2}:\\d{2}(am|pm) · 0\\.7 Showing Latest$`));
    expect(latest.lines[1]).toBe(`#1 · ${o} · 18 Oct 2026, 9:12am · 0.5`);
    expect(latest.html).toContain("<strong>#2</strong>");
    expect(latest.html).toContain(`<a href="/${o}/platforms/laptop/v/1">#1</a>`);
    expect(latest.html).toContain(`<a href="/${o}">${o}</a>`);
    const old = versionsOf((await renderPage(PlatformVersionPage, { owner: o, slug: "laptop", n: "1" })).html);
    expect(old.html).toContain(`<a href="/${o}/platforms/laptop">#2</a>`);
  });

  it("links each other version to the same tab", async () => {
    const o = await laptop();
    expect(linksOf((await renderPage(PlatformRecipePage, { owner: o, slug: "laptop" })).html)).toEqual({
      "1": `/${o}/platforms/laptop/v/1/recipe`,
    });
    expect(linksOf((await renderPage(PlatformVersionYamlPage, { owner: o, slug: "laptop", n: "1" })).html)).toEqual({
      "2": `/${o}/platforms/laptop/yaml`,
    });
  });
});

describe("a private workflow's versions", () => {
  // Acme keeps a private payroll at two versions; Olive owns acme and Mo is a
  // member. Bea owns beta, and Nell belongs to nothing.
  async function payroll() {
    const olive = await person("olive");
    const mo = await person("mo");
    const bea = await person("bea");
    const nell = await person("nell");
    await orgWith("acme", olive, [mo]);
    await orgWith("beta", bea);
    for (const visibility of ["private", undefined]) {
      const res = await request("POST", "/api/v1/acme/payroll/versions", {
        as: { token: olive.token },
        json: { workflow: example("dinners.yaml"), ...(visibility ? { visibility } : {}) },
      });
      expect(res.status).toBe(201);
    }
    return { olive, mo, bea, nell };
  }
  const pages = async (who: Who) => [
    await renderPage(WorkflowPage, { owner: "acme", slug: "payroll" }, { as: who }),
    await renderPage(VersionPage, { owner: "acme", slug: "payroll", n: "1" }, { as: who }),
  ];

  it("are listed to the organisation's owner and members", async () => {
    const { olive, mo } = await payroll();
    for (const who of [olive, mo]) {
      for (const page of await pages(who)) {
        expect(page.status).toBe(200);
        expect(versionsOf(page.html).lines).toHaveLength(2);
      }
    }
  });

  it("give anyone else the 404 of a missing workflow, at each address the list links to", async () => {
    const { bea, nell } = await payroll();
    for (const who of [bea, nell, undefined]) {
      for (const page of await pages(who)) expect(page).toEqual({ status: 404, html: "" });
    }
    expect(await renderPage(WorkflowPage, { owner: "acme", slug: "nothing" }, { as: nell })).toEqual({ status: 404, html: "" });
  });
});
