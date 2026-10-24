import fs from "node:fs";
import path from "node:path";
import { isValidElement, type ReactNode } from "react";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { LoginForm } from "@/components/LoginForm";
import { drawingFont } from "@/components/Mermaid";
import { getDb } from "@/db/client";
import { organisation, user, version } from "@/db/schema";
import { engine } from "@/engine";
import { createOrganisation } from "@/server/organisations";
import { listTokens } from "@/server/tokens";
import { inventory } from "@/server/registry";
import { getViewer } from "@/server/viewer";
import HomePage from "@/app/page";
import GalleryPage from "@/app/gallery/page";
import OwnerPage from "@/app/[owner]/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowSecurityPage from "@/app/[owner]/[slug]/security/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionSecurityPage from "@/app/[owner]/[slug]/v/[n]/security/page";
import VersionPlatformPage from "@/app/[owner]/[slug]/v/[n]/platform/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import { copyText } from "@/components/CopyButton";
import TokensPage from "@/app/settings/tokens/page";
import LoginPage from "@/app/login/page";
import { makeToken } from "@/app/settings/tokens/actions";
import { example, orgWith, person, request, signIn, storeLegacyVersion, withEdition, type Who } from "./helpers";
import { pageRequest, renderPage } from "./pages";

// Most of these pages are shown here for versions stored before the registry
// took only AWML 0.4 files, a 0.2 pair, which they still show as they were;
// test/one-file.test.tsx shows them for 0.4 files.
const security = example("legacy/dinners-security.yaml");
const platform = example("legacy/dinners-platform.yaml");
const dinners = example("dinners.yaml");

const withTitle = (title: string) => security.replace("title: The family's dinners", `title: ${title}`);

// A workflow with no AI, nobody deciding and no platform file.
const binDay = `awml: "0.2"
title: Bin day
view: security
groups:
  - { id: home, label: "home: Sam" }
parts:
  - { id: wed, kind: trigger, label: "Wednesday 18:00" }
  - { id: remind, kind: code, op: do, label: "Post the bin reminder", in: home }
  - { id: chat, kind: surface, label: "House chat", in: home }
lines:
  - { from: wed, to: remind, kind: start }
  - { from: remind, to: chat, kind: data }
`;

// The page's text, with tags and the spaces between them taken out.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// The page's view tabs: where each goes, what it says, and whether it is the one on show.
const tabs = (html: string) =>
  [...html.matchAll(/<a role="tab" href="([^"]*)" aria-selected="(true|false)">(.*?)<\/a>/g)].map(
    ([, href, selected, inner]) => ({
      href,
      label: text(inner).trim(),
      selected: selected === "true",
    }),
  );

// The page's header: owner / slug, title, visibility and version.
const header = (html: string) => text(html.split('<section class="wf-head">')[1].split("</section>")[0]).trim();

// The messages `awml check` gives for test/fixtures/bad.yaml.
const badMessages = () =>
  example("bad.check.txt")
    .trim()
    .split("\n")
    .map((l) => l.replace(/^bad\.yaml: /, ""));

// What the Checks view says before and after its files.
const CHECKS_INTRO =
  "AWML checked each file when it was pushed, and the registry refuses a push with any mistake. " +
  "Each file is checked again here, by the AWML this registry runs.";
const CHECKS_END = "AWML lists the mistakes it finds, not each rule it checks. Its spec says what it checks for.";

// The text of each file a page shows, by the id of its box.
const files = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<pre id="([^"]+)">([^]*?)<\/pre>/g)].map(([, id, body]) => [
      id,
      body
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&"),
    ]),
  );

// Stores a version of the files given, as a version stored before the
// registry took only 0.4 files, or pushes a 0.4 workflow.
async function push(
  owner: string,
  slug: string,
  by: { id: string; token: string },
  body: { security?: string; platform?: string; workflow?: string; visibility?: "public" | "private" },
) {
  if (body.workflow !== undefined) {
    const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as: { token: by.token }, json: body });
    expect(res.status).toBe(201);
    return;
  }
  const { visibility, ...files } = body;
  await storeLegacyVersion(owner, slug, by, files, visibility);
}

describe("the public gallery", () => {
  it("lists public workflows newest first and searches them by title", async () => {
    const ana = await person("ana");
    await push(ana.username, "older", ana, { security: withTitle("Weekly dinners") });
    await new Promise((r) => setTimeout(r, 5));
    await push(ana.username, "newer", ana, { security: withTitle("Client email") });
    const all = (await renderPage(GalleryPage, {})).html;
    expect(all.indexOf("Client email")).toBeLessThan(all.indexOf("Weekly dinners"));
    const found = (await renderPage(GalleryPage, {}, { search: { q: "dinner" } })).html;
    expect(found).toContain("Weekly dinners");
    expect(found).not.toContain("Client email");
    expect((await renderPage(GalleryPage, {}, { search: { q: "%" } })).html).toContain("No public workflow");
  });

  it("shows each workflow as a card with its drawing, who decides its steps and its address", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", ana, { security, platform });
    const page = await renderPage(GalleryPage, {});
    const shown = text(page.html);
    expect(shown).toContain("Public workflows");
    expect(shown).toContain("Workflows people have drawn and shared. Borrow one and make it yours.");
    expect(shown).toContain("The family's dinners AI 1 Code 3 ana / dinners");
    expect(page.html).toContain(await engine.draw(security).then((m) => m.split("\n")[0]));
    expect(page.html).toContain('placeholder="Search by title"');
    expect(page.html).toContain('action="/gallery"');
  });

  it("is the home page unless the edition gives one", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", ana, { security });
    await withEdition({ homePage: undefined }, async () => {
      expect((await renderPage(HomePage, {})).html).toContain("The family&#x27;s dinners");
    });
    await withEdition({ homePage: () => <p>Hosted home</p> }, async () => {
      expect((await renderPage(HomePage, {})).html).toBe("<p>Hosted home</p>");
    });
  });

  it("moved from /explore, which sends old links and searches to /gallery for good", async () => {
    const searched = await request("GET", "/explore?q=family+dinners");
    expect(searched.status).toBe(308);
    expect(searched.headers.get("location")).toBe("/gallery?q=family+dinners");
    expect((await request("GET", "/explore")).headers.get("location")).toBe("/gallery");
  });
});

describe("a workflow's page", () => {
  it("draws one view at a time behind a tab for each, each tab its own address", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    const page = await renderPage(WorkflowPage, { owner: o, slug: "dinners" });
    const shown = text(page.html);
    expect(shown).toContain(`${o} / dinners The family's dinners Public · Version 1 of 1 Who may see each part`);
    expect(page.html).toContain(await engine.draw(security).then((m) => m.split("\n")[0]));
    expect(tabs(page.html)).toEqual([
      { href: `/${o}/dinners/security`, label: "Who may see each part", selected: true },
      { href: `/${o}/dinners/platform`, label: "Where each part runs", selected: false },
      { href: `/${o}/dinners/yaml`, label: "YAML", selected: false },
      { href: `/${o}/dinners/checks`, label: "Checks No mistakes", selected: false },
    ]);
    expect(page.html).not.toContain("?view=");

    // The security view's own address is the same page.
    expect((await renderPage(WorkflowSecurityPage, { owner: o, slug: "dinners" })).html).toBe(page.html);

    const other = await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" });
    expect(other.status).toBe(200);
    expect(other.html).toContain(await engine.draw(platform).then((m) => m.split("\n")[1]));
    expect(
      tabs(other.html)
        .filter((t) => t.selected)
        .map((t) => t.href),
    ).toEqual([`/${o}/dinners/platform`]);
  });

  it("keeps its header to the owner, title, visibility and version on every view: no buttons and no badge", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    const params = { owner: o, slug: "dinners" };
    for (const page of [
      WorkflowPage,
      WorkflowSecurityPage,
      WorkflowPlatformPage,
      WorkflowYamlPage,
      WorkflowChecksPage,
    ]) {
      const html = (await renderPage(page, params)).html;
      expect(header(html), page.name).toBe(`${o} / dinners The family's dinners Public · Version 1 of 1`);
      expect(html, page.name).not.toContain("Change this workflow");
      expect(html, page.name).not.toContain("Download YAML");
    }
  });

  it("gives an older version's views their own addresses, and its tabs keep to that version", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    await push(o, "dinners", ana, { security: withTitle("Dinners for two"), platform });
    const v1 = { owner: o, slug: "dinners", n: "1" };

    const drawn = await renderPage(VersionPlatformPage, v1);
    expect(drawn.status).toBe(200);
    expect(header(drawn.html)).toMatch(new RegExp(`^${o} / dinners Dinners for two Public · Version 1 of 2 #2 `));
    expect(drawn.html).toContain(await engine.draw(platform).then((m) => m.split("\n")[1]));
    expect(tabs(drawn.html)).toEqual([
      { href: `/${o}/dinners/v/1/security`, label: "Who may see each part", selected: false },
      { href: `/${o}/dinners/v/1/platform`, label: "Where each part runs", selected: true },
      { href: `/${o}/dinners/v/1/yaml`, label: "YAML", selected: false },
      { href: `/${o}/dinners/v/1/checks`, label: "Checks No mistakes", selected: false },
    ]);
    expect((await renderPage(VersionSecurityPage, v1)).html).toBe((await renderPage(VersionPage, v1)).html);
    expect(files((await renderPage(VersionYamlPage, v1)).html)["security-yaml"]).toBe(security);
  });

  it("sends the old ?view= addresses for good (308) to the view's own address, on the latest version and on older ones", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    for (const view of ["security", "platform", "yaml"]) {
      expect(await renderPage(WorkflowPage, { owner: o, slug: "dinners" }, { search: { view } })).toEqual({
        status: 308,
        html: "",
        location: `/${o}/dinners/${view}`,
      });
      expect(await renderPage(VersionPage, { owner: o, slug: "dinners", n: "1" }, { search: { view } })).toEqual({
        status: 308,
        html: "",
        location: `/${o}/dinners/v/1/${view}`,
      });
    }
    // A view it does not know leaves the page as it is.
    expect((await renderPage(WorkflowPage, { owner: o, slug: "dinners" }, { search: { view: "other" } })).status).toBe(
      200,
    );
    // Each part of the address it sends to stays inside its own segment.
    expect(
      await renderPage(WorkflowPage, { owner: "/evil.example", slug: "a b" }, { search: { view: "yaml" } }),
    ).toMatchObject({
      status: 308,
      location: "/%2Fevil.example/a%20b/yaml",
    });
  });

  it("is not found at /platform when the workflow has no platform file, on the latest version or an older one", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "bins", ana, { security: binDay });
    expect((await renderPage(WorkflowPlatformPage, { owner: o, slug: "bins" })).status).toBe(404);
    expect((await renderPage(VersionPlatformPage, { owner: o, slug: "bins", n: "1" })).status).toBe(404);
    const page = await renderPage(WorkflowSecurityPage, { owner: o, slug: "bins" });
    expect(page.status).toBe(200);
    expect(tabs(page.html).map((t) => t.href)).toEqual([`/${o}/bins/security`, `/${o}/bins/yaml`, `/${o}/bins/checks`]);
  });

  it("keeps each file's raw download at /v/{n}/{view}.yaml", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    for (const [view, body] of [
      ["security", security],
      ["platform", platform],
    ]) {
      const res = await request("GET", `/${o}/dinners/v/1/${view}.yaml`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
      expect(await res.text()).toBe(body);
    }
    expect((await request("GET", `/${o}/dinners/v/1/yaml.yaml`)).status).toBe(404);
  });

  it("says who decides, what reaches outside, what leaves its scope and everything in it", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", ana, { security, platform });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain("Who decides 1 AI 3 code No step is decided by a person.");
    expect(shown).toContain("Outside actions Allow 1 Ask 1 Block 0");
    expect(shown).toContain("Leaves its scope standing rule: dinners to carers");
    expect(shown).toContain("Everything in it Triggers 3 Reviews 1 Notes 3 Connectors 3 Surfaces 3 Scopes 3");
  });

  it("orders the side panel: who decides, outside actions, what leaves, change it, everything in it", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", ana, { security, platform });
    await push(ana.username, "dinners", ana, { security: withTitle("Dinners"), platform });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    const order = ["Who decides", "Outside actions", "Leaves its scope", "Change it", "Everything in it"];
    const at = order.map((h) => shown.indexOf(h));
    expect(
      at.every((i) => i >= 0),
      String(at),
    ).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("leaves out what leaves its scope when nothing does", async () => {
    const ana = await person("ana");
    await push(ana.username, "bins", ana, { security: binDay });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "bins" })).html);
    expect(shown).toContain("Outside actions");
    expect(shown).not.toContain("Leaves its scope");
    expect(shown).not.toContain("Nothing leaves its scope.");
  });

  it("says how to change it with your own AI or from your machine, and that the version before stays", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", ana, { security, platform });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain(
      "Change it Every change is checked, then saved as version 2. Version 1 stays as it is. " +
        "Ask your own AI Connect Claude or ChatGPT to the registry and tell it what to change. " +
        "It runs on your account, not ours. http://localhost:3000/mcp " +
        `Push from your machine awml push ${ana.username}/dinners workflow.yaml`,
    );
    expect(shown).not.toContain("Edit the YAML here");
  });

  it("names the person steps when people decide some of the steps", async () => {
    const ana = await person("ana");
    const withPerson = security.replace('kind: ai, label: "Plan', 'kind: person, label: "Plan');
    await push(ana.username, "dinners", ana, { security: withPerson });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain("Who decides 3 code 1 person 1 step is decided by a person.");
    expect(shown).toContain("Who may see each part");
    expect(shown).not.toContain("Where each part runs");
  });
});

describe("a workflow's YAML view", () => {
  const tricky = binDay.replace("title: Bin day", "title: Bin <day> & co");

  it("shows only the raw files under the header: no drawing, no summary panels and no Change it box", async () => {
    const ana = await person("ana");
    const o = ana.username;
    const titled = withTitle("Dinners <b>&</b>");
    await push(o, "dinners", ana, { security: titled, platform });
    const page = await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" });
    expect(page.status).toBe(200);
    const shown = text(page.html);
    expect(shown).toContain(
      `${o} / dinners Dinners <b>&</b> Public · Version 1 of 1 ` +
        "Who may see each part Where each part runs YAML Checks No mistakes security.yaml Copy Download # The family's dinners",
    );
    expect(
      tabs(page.html)
        .filter((t) => t.selected)
        .map((t) => t.href),
    ).toEqual([`/${o}/dinners/yaml`]);
    expect(page.html).not.toContain("<figure");
    expect(page.html).not.toContain("flowchart");
    for (const gone of [
      "Who decides",
      "Outside actions",
      "Leaves its scope",
      "Everything in it",
      "Versions",
      "Change it",
      "Change this workflow",
      "Download YAML",
      "awml push",
    ])
      expect(shown, gone).not.toContain(gone);

    expect(files(page.html)).toEqual({ "security-yaml": titled, "platform-yaml": platform });
    expect(page.html).not.toContain("<b>&</b>");
    expect(shown.indexOf("security.yaml")).toBeLessThan(shown.indexOf("platform.yaml"));
    for (const view of ["security", "platform"]) {
      expect(page.html).toContain(
        `<button type="button" class="button outline" aria-controls="${view}-yaml">Copy</button>`,
      );
      expect(page.html).toContain(
        `<a href="/${o}/dinners/v/1/${view}.yaml" class="button outline" download="">Download</a>`,
      );
    }
  });

  it("shows only the security file when there is no platform file", async () => {
    const ana = await person("ana");
    await push(ana.username, "bins", ana, { security: tricky });
    const page = await renderPage(WorkflowYamlPage, { owner: ana.username, slug: "bins" });
    expect(files(page.html)).toEqual({ "security-yaml": tricky });
    expect(text(page.html)).not.toContain("platform.yaml");
  });

  it("works on an older version", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "bins", ana, { security: binDay });
    await push(o, "bins", ana, { security: tricky });
    const page = await renderPage(VersionYamlPage, { owner: o, slug: "bins", n: "1" });
    expect(page.status).toBe(200);
    expect(files(page.html)).toEqual({ "security-yaml": binDay });
    expect(page.html).toContain(`href="/${o}/bins/v/1/security.yaml"`);
    expect(
      tabs(page.html)
        .filter((t) => t.selected)
        .map((t) => t.href),
    ).toEqual([`/${o}/bins/v/1/yaml`]);
  });

  it("copies a file with the clipboard, and selects its text for the person to copy where the browser will not", async () => {
    const written: string[] = [];
    let selected = 0;
    const select = () => {
      selected++;
    };
    expect(await copyText("a: 1\n", { writeText: async (t: string) => void written.push(t) }, select)).toBe("Copied");
    expect([written, selected]).toEqual([["a: 1\n"], 0]);

    const refused = { writeText: () => Promise.reject(new Error("Write permission denied.")) };
    for (const clipboard of [undefined, refused]) {
      expect(await copyText("a: 1\n", clipboard, select)).toBe("Selected: press Ctrl+C or ⌘C to copy");
    }
    expect(selected).toBe(2);
  });

  it("is not found for someone outside a private workflow's organisation, and shown to a member", async () => {
    const ana = await person("ana");
    const bo = await person("bo");
    await orgWith("cares", ana);
    await push("cares", "secret", ana, { security: binDay, visibility: "private" });
    const params = { owner: "cares", slug: "secret" };
    expect((await renderPage(WorkflowYamlPage, params)).status).toBe(404);
    expect((await renderPage(WorkflowYamlPage, params, { as: bo })).status).toBe(404);
    expect((await renderPage(VersionYamlPage, { ...params, n: "1" }, { as: bo })).status).toBe(404);
    const member = await renderPage(WorkflowYamlPage, params, { as: ana });
    expect(member.status).toBe(200);
    expect(files(member.html)).toEqual({ "security-yaml": binDay });
  });
});

describe("a workflow's Checks view", () => {
  it("is a fourth tab, after YAML, with a tick when every file passes, and lists each file checked and the AWML that checked it", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(page.status).toBe(200);
    expect(tabs(page.html).map((t) => [t.label, t.selected])).toEqual([
      ["Who may see each part", false],
      ["Where each part runs", false],
      ["YAML", false],
      ["Checks No mistakes", true],
    ]);
    expect(tabs(page.html)[3].href).toBe(`/${o}/dinners/checks`);
    expect(text(page.html)).toContain(
      `${o} / dinners The family's dinners Public · Version 1 of 1 Who may see each part Where each part runs YAML Checks No mistakes ` +
        `${CHECKS_INTRO} ` +
        "security.yaml Checked by AWML v0.5.1 awml check No mistakes " +
        "platform.yaml Checked by AWML v0.5.1 awml check No mistakes " +
        CHECKS_END,
    );
    expect(page.html).toContain(
      'href="https://github.com/chrismdp/awml/blob/6d33d362e4c713f697ef684ac36d5a9bb7864466/SPEC.md#the-file-format"',
    );
    expect(page.html).not.toContain("<figure");
    expect(page.html).not.toContain("<pre");
    for (const gone of ["Who decides", "Outside actions", "Leaves its scope", "Everything in it", "Change it"])
      expect(text(page.html), gone).not.toContain(gone);
  });

  it("counts the mistakes on its tab and lists each under its file, and a file with mistakes is not drawn", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", ana, { security, platform });
    // A version AWML now finds a mistake in: a push is refused for one, so
    // only a stored file checked again by a newer AWML can be like this.
    await (await getDb()).update(version).set({ security: example("bad.yaml") });
    const [mistake] = badMessages();

    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(page.status).toBe(200);
    expect(tabs(page.html)[3]).toEqual({ href: `/${o}/dinners/checks`, label: "Checks 1 mistake", selected: true });
    expect(text(page.html)).toContain(
      `security.yaml Checked by AWML v0.5.1 awml check 1 mistake ${mistake} ` +
        "platform.yaml Checked by AWML v0.5.1 awml check No mistakes",
    );
    expect(header(page.html)).toBe(`${o} / dinners The family's dinners Public · Version 1 of 1`);

    const drawn = await renderPage(WorkflowPage, { owner: o, slug: "dinners" });
    expect(drawn.status).toBe(200);
    expect(drawn.html).not.toContain("flowchart");
    expect(text(drawn.html)).toContain("security.yaml has 1 mistake, so it cannot be drawn. See Checks.");
    expect(drawn.html).toContain(`href="/${o}/dinners/checks"`);
    expect(tabs(drawn.html)[3].label).toBe("Checks 1 mistake");
    // The other file still draws.
    const other = await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" });
    expect(other.html).toContain(await engine.draw(platform).then((m) => m.split("\n")[1]));
  });

  it("works on an older version, each file checked as that version has it", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "bins", ana, { security: binDay });
    await push(o, "bins", ana, { security, platform });
    const page = await renderPage(VersionChecksPage, { owner: o, slug: "bins", n: "1" });
    expect(page.status).toBe(200);
    expect(tabs(page.html).map((t) => t.href)).toEqual([
      `/${o}/bins/v/1/security`,
      `/${o}/bins/v/1/yaml`,
      `/${o}/bins/v/1/checks`,
    ]);
    expect(text(page.html)).toContain(
      `${CHECKS_INTRO} security.yaml Checked by AWML v0.5.1 awml check No mistakes ${CHECKS_END}`,
    );
  });
});

describe("an owner's page", () => {
  it("is headed with the owner's name, or their username or slug when the name is empty", async () => {
    const db = await getDb();
    const ana = await person("ana");
    await orgWith("acme", ana);
    const heading = async (owner: string) => (await renderPage(OwnerPage, { owner })).html.match(/<h1>(.*?)<\/h1>/)?.[1];
    await db.update(user).set({ name: "Ana Cook" }).where(eq(user.id, ana.id));
    expect(await heading(ana.username)).toBe("Ana Cook");
    await db.update(user).set({ name: "" }).where(eq(user.id, ana.id));
    expect(await heading(ana.username)).toBe(ana.username);
    await db.update(organisation).set({ name: "" }).where(eq(organisation.slug, "acme"));
    expect(await heading("acme")).toBe("acme");
  });
});

describe("an organisation's inventory", () => {
  it("shows every workflow's latest summary and totals across them, listing publishing line labels", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    await push("acme", "dinners", olive, { security });
    await push("acme", "dinners", olive, { security, platform });
    await push("acme", "payroll", olive, { security, visibility: "private" });
    const both = JSON.parse(example("legacy/dinners.summary.json"));
    const one = JSON.parse(example("legacy/dinners-security.summary.json"));

    const inv = (await inventory(await getDb(), await getViewer(new Headers({ cookie: olive.cookie })), "acme"))!;
    expect(inv.rows.map((r) => [r.slug, r.latest])).toEqual([
      ["dinners", 2],
      ["payroll", 1],
    ]);
    expect(inv.rows[0].summary).toEqual(both);
    expect(inv.totals.steps.code).toBe(both.steps.code + one.steps.code);
    expect(inv.totals.outsideActions.ask).toBe(both.outsideActions.ask + one.outsideActions.ask);
    expect(inv.totals.operations.do).toBe(both.operations.do + one.operations.do);
    expect(inv.totals.platforms).toBe(both.platforms + one.platforms);
    expect(inv.totals.publishingLines.count).toBe(both.publishingLines.count + one.publishingLines.count);
    expect(inv.totals.publishingLines.labels).toEqual(["standing rule: dinners to carers"]);
  });

  it("counts where AI and people are across the workflows, and lists each one's AI steps, people, scopes and platforms", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    await push("acme", "dinners", olive, { security, platform, visibility: "private" });
    await push("acme", "bin-day", olive, { security: binDay });

    const page = await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } });
    expect(page.status).toBe(200);
    const shown = text(page.html);
    expect(shown).toContain("Workflows Inventory Platforms Members Audit log");
    expect(shown).toContain("acme's AI workflows");
    expect(shown).toContain("Where AI is, where people are, what it can see and where it runs.");
    expect(shown).toContain("1 of 2 use AI somewhere");
    expect(shown).toContain("1 of 2 have no person in them at all");
    expect(shown).toContain("4 scopes touched, 1 line leaves one");
    expect(shown).toContain("1 of 2 don't say where they run yet");
    expect(shown).toContain("Workflow AI People Scopes it touches Runs on");
    expect(shown).toContain("Bin day Public None Code only Nobody home No platform view yet");
    expect(shown).toContain(
      "The family's dinners Private · 1 line leaves a scope 1 of 4 steps Plan next week's dinners 1 review Owen's yes to the exact basket carers family household Server: claude-sonnet-4-5 The family messaging app The supermarket The calendar The kitchen screen",
    );
  });

  it("says so when an organisation has no workflows yet", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    const shown = text((await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } })).html);
    expect(shown).toContain("acme has no workflows yet. Push the first one with awml push acme/<name> workflow.yaml");
    expect(shown).not.toContain("use AI somewhere");
  });
});

describe("the sign-in page", () => {
  it("offers only the providers that are set up, and always the email link", async () => {
    const shown = text((await renderPage(LoginPage, {})).html);
    expect(shown).toContain("Sign in New here? This makes your account too.");
    expect(shown).toContain("Email me a link");
    expect(shown).toContain("The link works once, for 15 minutes. No passwords.");
    expect(shown).not.toContain("Continue with GitHub");
    expect(shown).not.toContain("or by email");

    process.env.GITHUB_CLIENT_ID = "id";
    try {
      const withGitHub = text((await renderPage(LoginPage, {})).html);
      expect(withGitHub).toContain("Continue with GitHub");
      expect(withGitHub).not.toContain("Continue with Google");
      expect(withGitHub).toContain("or by email");
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
    }
  });

  it("tells the form what to say once the link is sent: that it went to the server log, unless email is set up", async () => {
    const sentNotice = async () => {
      pageRequest.headers = new Headers();
      const page = await LoginPage({ searchParams: Promise.resolve({}) });
      return propsOf(page, LoginForm)?.sent;
    };
    const withoutEmail = await sentNotice();
    expect(withoutEmail).toMatch(/printed to the server's log/);
    expect(withoutEmail).not.toMatch(/check your email/i);

    process.env.MAIL_FROM = "Registry <login@registry.example.com>";
    process.env.SMTP_URL = "smtp://mail.example.com";
    try {
      expect(await sentNotice()).toMatch(/check your email/i);
    } finally {
      delete process.env.MAIL_FROM;
      delete process.env.SMTP_URL;
    }
  });
});

// The props of the first element of a type in a server component's tree.
function propsOf<P>(node: ReactNode, type: (props: P) => ReactNode): P | undefined {
  if (Array.isArray(node)) return node.map((n) => propsOf(n, type)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node.props as P;
  return propsOf(node.props.children, type);
}

describe("names", () => {
  it("gives a user a username from their email on first sign-in, avoiding reserved and taken names", async () => {
    expect((await signIn("ana@example.com")).user.username).toBe("ana");
    expect((await signIn("ana@elsewhere.com")).user.username).toBe("ana-2");
    expect((await signIn("admin@example.com")).user.username).toBe("admin-2");
    expect((await signIn("mcp@example.com")).user.username).toBe("mcp-2");
    expect((await signIn("consent@example.com")).user.username).toBe("consent-2");
    expect((await signIn("gallery@example.com")).user.username).toBe("gallery-2");
  });

  it("refuses an organisation slug that is reserved, malformed or taken by a user", async () => {
    const ana = await person("ana");
    const db = await getDb();
    for (const slug of ["gallery", "explore", "api", "Bad Slug", "ana"]) {
      const made = await createOrganisation(db, ana.id, { slug, name: "x" });
      expect(made.ok, slug).toBe(false);
    }
    const res = await request("POST", "/api/orgs", {
      as: { cookie: ana.cookie },
      form: { slug: "acme", name: "Acme" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/acme/settings");
    const again = await request("POST", "/api/orgs", {
      as: { cookie: ana.cookie },
      form: { slug: "acme", name: "Acme" },
    });
    expect(again.headers.get("location")).toContain("error=");
  });

  it("refuses a workflow slug the organisation's own pages use", async () => {
    const ana = await person("ana");
    for (const slug of ["inventory", "settings", "platforms"]) {
      const res = await request("POST", `/api/v1/${ana.username}/${slug}/versions`, {
        as: { token: ana.token },
        json: { security },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).errors).toEqual([`"${slug}" is reserved.`]);
    }
  });
});

describe("the tokens page", () => {
  it("shows a new token's secret once, then lists it by name only", async () => {
    const ana = await signIn("ana@example.com");
    pageRequest.headers = new Headers({ cookie: ana.cookie });
    const form = new FormData();
    form.set("name", "laptop");
    const made = await makeToken({}, form);
    expect(made.secret).toMatch(/^awml_/);
    const tokens = await listTokens(await getDb(), ana.user.id);
    expect(tokens.map((t) => t.name)).toEqual(["laptop"]);
    const page = await renderPage(TokensPage, {}, { as: { cookie: ana.cookie } });
    expect(page.html).toContain("laptop");
    expect(page.html).not.toContain(made.secret);
    const res = await request("GET", "/api/v1/ana/anything", { as: { token: made.secret } });
    expect(res.status).toBe(404);
  });

  it("sends a signed-out visitor to sign in", async () => {
    expect(await renderPage(TokensPage, {})).toMatchObject({ status: 307, location: "/login?next=/settings/tokens" });
  });
});

describe("the engine", () => {
  it("names the AWML it was built from: the commit vendor/awml/VERSION gives, and its release", () => {
    const vendored = fs.readFileSync(path.join("vendor", "awml", "VERSION"), "utf8").split("\n")[0];
    expect(engine.version).toEqual({ tag: "v0.5.1", commit: vendored.split(" ")[1] });
  });

  it("gives the verdict, summary and drawing the native awml gives", async () => {
    expect(await engine.check(dinners)).toEqual([]);
    expect(await engine.check(example("bad-04.yaml"))).toEqual(
      example("bad-04.check.txt").trim().split("\n").map((l) => l.replace(/^bad-04\.yaml: /, "")),
    );
    expect(await engine.check("- just a list\n")).not.toEqual([]);
    expect(await engine.summarise({ workflow: dinners })).toEqual(JSON.parse(example("dinners.summary.json")));
    expect(await engine.draw(dinners)).toBe(example("dinners.mmd").replace(/\n$/, ""));
    expect(await engine.draw(dinners, "home")).toBe(example("dinners-home.mmd").replace(/\n$/, ""));
  });

  it("still reads the files of versions stored before 0.4, as the native awml does", async () => {
    expect(await engine.check(security)).toEqual([]);
    expect(await engine.check(example("bad.yaml"))).toEqual(
      example("bad.check.txt")
        .trim()
        .split("\n")
        .map((l) => l.replace(/^bad\.yaml: /, "")),
    );
    expect(await engine.summarise({ security, platform })).toEqual(JSON.parse(example("legacy/dinners.summary.json")));
    expect(await engine.summarise({ platform })).toEqual(JSON.parse(example("legacy/dinners-platform.summary.json")));
    expect(await engine.draw(security)).toBe(example("legacy/dinners-security.mmd").replace(/\n$/, ""));
    expect(await engine.draw(platform)).toBe(example("legacy/dinners-platform.mmd").replace(/\n$/, ""));
  });
});

describe("drawing a workflow", () => {
  it("asks for Inter, which the registry serves itself under the SIL Open Font License", async () => {
    expect(drawingFont(await engine.draw(security))).toBe("Inter, sans-serif");
    const css = fs.readFileSync(path.join("src", "app", "site.css"), "utf8");
    const face = /@font-face\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(face).toMatch(/font-family:\s*"Inter"/);
    const src = /src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/.exec(face)?.[1];
    expect(src).toBeDefined();
    const file = path.join("src", "app", src!);
    expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe("wOF2");
    expect(fs.readFileSync(path.join(path.dirname(file), "LICENSE.txt"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });
});

describe("the terms and privacy policy", () => {
  it("are linked from the sign-in page only when the edition gives them", async () => {
    await withEdition({ legalLinks: undefined }, async () => {
      const plain = await renderPage(LoginPage, {});
      expect(plain.html).not.toContain('href="/terms"');
      expect(text(plain.html)).not.toContain("By signing in you agree");
      expect(text(plain.html)).toContain("We never send your workflows to a model.");
    });
    await withEdition({ legalLinks: { terms: "/legal/terms", privacy: "/legal/privacy" } }, async () => {
      const linked = await renderPage(LoginPage, {});
      expect(linked.html).toContain('href="/legal/terms"');
      expect(linked.html).toContain('href="/legal/privacy"');
      expect(text(linked.html)).toContain("By signing in you agree to the terms and privacy policy");
      expect(text(linked.html)).toContain("We never send your workflows to a model.");
    });
  });
});

describe("the favicon", () => {
  it("is the logomark, in ink on light and white on dark", () => {
    const icon = fs.readFileSync(path.join("src", "app", "icon.svg"), "utf8");
    for (const part of [
      'd="M20 14 V8"',
      'cx="20" cy="6"',
      'x="5" y="15" width="30" height="30" rx="8"',
      'd="M47 22.8 L56 30 L47 37.2 Z"',
    ])
      expect(icon, part).toContain(part);
    expect(icon).toContain("prefers-color-scheme: dark");
  });
});
