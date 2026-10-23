// The Versions list on a workflow's page and a platform's page: each version
// on one line, as "#8 · chrismdp · Today 4:43pm · 0.4".
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { platformVersion, version } from "@/db/schema";
import { ukTime } from "@/server/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import PlatformPage from "@/app/platforms/[owner]/[slug]/page";
import PlatformVersionPage from "@/app/platforms/[owner]/[slug]/v/[n]/page";
import { example, person, request, storeLegacyVersion } from "./helpers";
import { renderPage } from "./pages";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Each line of the Versions list, as text, and the list's markup.
const versionsOf = (html: string) => {
  const list = /<ol class="versions">([^]*?)<\/ol>/.exec(html)?.[1] ?? "";
  return { html: list, lines: [...list.matchAll(/<li>([^]*?)<\/li>/g)].map(([, li]) => text(li)) };
};

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
    await storeLegacyVersion(o, "dinners", ana, {
      security: example("legacy/dinners-security.yaml"),
      platform: example("legacy/dinners-platform.yaml"),
    });
    await storeLegacyVersion(o, "dinners", ana, { security: example("legacy/client-email-security.yaml") });
    const pushed = await request("POST", `/api/v1/${o}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: example("dinners.yaml") },
    });
    expect(pushed.status).toBe(201);
    const db = await getDb();
    await db.update(version).set({ pushedAt: OCT_18 }).where(eq(version.number, 1));

    const latest = versionsOf((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html);
    expect(latest.lines[0]).toMatch(new RegExp(`^#3 · ${o} · Today \\d{1,2}:\\d{2}(am|pm) · 0\\.5$`));
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
  });
});

describe("a platform's Versions list", () => {
  it("shows each version the same way", async () => {
    const ana = await person("ana");
    const o = ana.username;
    for (const description of [example("platforms/codex-laptop.yaml"), example("platforms/worker.yaml")]) {
      const res = await request("POST", `/api/v1/platforms/${o}/laptop/versions`, { as: { token: ana.token }, json: { description } });
      expect(res.status).toBe(201);
    }
    const db = await getDb();
    await db.update(platformVersion).set({ pushedAt: OCT_18 }).where(eq(platformVersion.number, 1));

    const latest = versionsOf((await renderPage(PlatformPage, { owner: o, slug: "laptop" })).html);
    expect(latest.lines[0]).toMatch(new RegExp(`^#2 · ${o} · Today \\d{1,2}:\\d{2}(am|pm) · 0\\.4$`));
    expect(latest.lines[1]).toBe(`#1 · ${o} · 18 Oct 2026, 9:12am · 0.4`);
    expect(latest.html).toContain("<strong>#2</strong>");
    expect(latest.html).toContain(`<a href="/platforms/${o}/laptop/v/1">#1</a>`);
    expect(latest.html).toContain(`<a href="/${o}">${o}</a>`);
    const old = versionsOf((await renderPage(PlatformVersionPage, { owner: o, slug: "laptop", n: "1" })).html);
    expect(old.html).toContain(`<a href="/platforms/${o}/laptop">#2</a>`);
  });
});
