// The registry takes AWML 0.8 files only: one file per workflow version,
// holding the design and any implementations. Older files are refused at
// push, and versions stored before stay readable as history, converted when
// read (test/older-awml.test.tsx shows that for 0.4 and 0.5 files).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { version } from "@/db/schema";
import { engine } from "@/engine";
import { PLATFORM_IS_TOO_OLD, WORKFLOW_IS_TOO_OLD } from "@/server/awml-file";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowSecurityPage from "@/app/[owner]/[slug]/security/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import ImplementationPage from "@/app/[owner]/[slug]/platform/[implementation]/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionPlatformPage from "@/app/[owner]/[slug]/v/[n]/platform/page";
import VersionImplementationPage from "@/app/[owner]/[slug]/v/[n]/platform/[implementation]/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import GalleryPage from "@/app/gallery/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import { drawing, expected, expectedOf } from "./drawn";
import { example, orgWith, person, request, storePlatformVersion, storeVersion, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage } from "./pages";

const dinners = example("dinners.yaml"); // 0.8
const clientEmail = example("client-email.yaml");
const legacySecurity = example("legacy/dinners-security.yaml"); // 0.2
const legacyPlatform = example("legacy/dinners-platform.yaml"); // 0.2
const clientEmail03 = example("legacy/client-email-security.yaml"); // 0.3
const ids = ["codex-laptop", "cowork-mac-mini", "scripts-mac-mini", "worker"];
const descriptions = Object.fromEntries(ids.map((id) => [id, example(`platforms/${id}.yaml`)]));

// The family's dinners with a second implementation, away from home, after
// the first, placing the parts home does in two blocks.
const homeParts = [...dinners.matchAll(/parts: \[([^\]]*)\]/g)].map((m) => m[1]);
const twoPlaces = `${dinners.trimEnd()}
  away:
    label: Away for the summer
    blocks:
      - { id: cloud, label: "A cloud server", parts: [${homeParts[0]}] }
      - { id: services, label: "Everyone's services", parts: [${homeParts.slice(1).join(", ")}] }
`;
// The same, saying nothing of where it runs.
const nowhere = dinners.slice(0, dinners.indexOf("implementations:"));

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const unescape = (html: string) =>
  html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const tabs = (html: string) =>
  [...html.matchAll(/<a ([^>]*\brole="tab"[^>]*)>(.*?)<\/a>/g)].map(([, attrs, inner]) => ({
    href: /\bhref="([^"]*)"/.exec(attrs)![1],
    label: text(inner).trim(),
    selected: attrs.includes('aria-selected="true"'),
  }));

// The choice of implementation on the platform tab: where each goes, its
// label, and whether it is the one drawn.
const choice = (html: string) =>
  [...html.matchAll(/<a ([^>]*\bclass="implementation"[^>]*)>(.*?)<\/a>/g)].map(([, attrs, inner]) => ({
    href: /\bhref="([^"]*)"/.exec(attrs)![1],
    label: text(inner).trim(),
    current: attrs.includes('aria-current="page"'),
  }));

const files = (html: string) =>
  Object.fromEntries([...html.matchAll(/<pre id="([^"]+)">([^]*?)<\/pre>/g)].map(([, id, body]) => [id, unescape(body)]));

// The ids of the checks the Checks tab lists, in the order it lists them.
const checkIds = (html: string) => [...html.matchAll(/<li data-check="([^"]+)"/g)].map((m) => m[1]);

async function push(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: body });
  return { status: res.status, body: await res.json() };
}

describe("pushing a workflow", () => {
  it("refuses a 0.3 or a 0.2 file through the API with a 400 that says to convert the pair, and stores nothing", async () => {
    const ana = await person("ana");
    const as = { token: ana.token };
    for (const body of [
      { security: clientEmail03 },
      { security: legacySecurity, platform: legacyPlatform },
      { platform: legacyPlatform },
      { workflow: clientEmail03 },
      { workflow: legacySecurity },
    ]) {
      expect(await push(ana.username, "dinners", as, body), JSON.stringify(Object.keys(body))).toEqual({
        status: 400,
        body: { errors: [WORKFLOW_IS_TOO_OLD] },
      });
    }
    expect((await request("GET", `/api/v1/${ana.username}/dinners`)).status).toBe(404);
  });

  it("refuses a 0.3 or a 0.2 file through the MCP publish and check tools with the same message", async () => {
    const ana = await person("ana");
    for (const files of [{ security: clientEmail03 }, { security: legacySecurity, platform: legacyPlatform }, { workflow: clientEmail03 }]) {
      for (const tool of ["publish", "check"]) {
        const answer = await call(tool, { owner: ana.username, slug: "dinners", ...files }, ana.token);
        expect(answer, `${tool} ${Object.keys(files)}`).toMatchObject({ isError: true, text: WORKFLOW_IS_TOO_OLD });
      }
    }
    expect((await call("get", { owner: ana.username, slug: "dinners" }, ana.token)).text).toBe("Not found.");
  });

  it("takes one 0.8 file as workflow, or alone as security, as awml push 0.4.0 sent it", async () => {
    const ana = await person("ana");
    const as = { token: ana.token };
    expect(dinners).toMatch(/^awml: "0\.8"$/m);
    expect(await push(ana.username, "dinners", as, { workflow: dinners })).toMatchObject({ status: 201, body: { number: 1 } });
    expect(await push(ana.username, "dinners", as, { security: dinners })).toMatchObject({ status: 201, body: { number: 2 } });
    const stored = await (await request("GET", `/api/v1/${ana.username}/dinners/v/2`)).json();
    expect(stored.files).toEqual({ workflow: dinners });
    expect(stored.summary).toEqual(JSON.parse(example("dinners.summary.json")));
    expect(stored.check).toEqual({ workflow: [] });
  });

  it("publishes and checks one 0.8 file through MCP", async () => {
    const ana = await person("ana");
    expect(await call("check", { workflow: twoPlaces }, ana.token)).toMatchObject({ isError: false, text: "No mistakes." });
    const published = await call("publish", { owner: ana.username, slug: "dinners", workflow: twoPlaces }, ana.token);
    expect(published).toMatchObject({ isError: false, data: { number: 1 } });
    const got = await call("get", { owner: ana.username, slug: "dinners" }, ana.token);
    expect(got.data.files).toEqual({ workflow: twoPlaces });
    expect(got.text).toContain(`workflow.yaml:\n${twoPlaces}`);
  });

  it("refuses a 0.8 file with mistakes with 422 and the messages `awml check` prints for it", async () => {
    const ana = await person("ana");
    const printed = example("bad-08.check.txt").trim().split("\n");
    const res = await push(ana.username, "broken", { token: ana.token }, { workflow: example("bad-08.yaml") });
    expect(res).toEqual({ status: 422, body: { errors: printed.map((l) => l.replace(/^bad-08\.yaml: /, "workflow: ")) } });
  });

  it("refuses more than one file, and a platform description sent as a workflow", async () => {
    const ana = await person("ana");
    const as = { token: ana.token };
    expect(await push(ana.username, "two", as, { workflow: dinners, security: dinners })).toEqual({
      status: 422,
      body: { errors: ["Send one file, as workflow: an AWML 0.8 workflow holds its design and its implementations."] },
    });
    expect(await push(ana.username, "box", as, { workflow: descriptions.worker })).toEqual({
      status: 422,
      body: { errors: ["workflow: this is a platform description, not a workflow. Push it as a platform."] },
    });
    expect(await push(ana.username, "none", as, {})).toEqual({
      status: 422,
      body: { errors: ["Send the workflow's AWML 0.8 file as workflow."] },
    });
  });
});

describe("pushing a platform description", () => {
  const old = descriptions.worker.replace('awml: "0.8"', 'awml: "0.3"');

  it("refuses an older one with a 400 through the API and the MCP tool", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/platforms/${ana.username}/worker/versions`, {
      as: { token: ana.token },
      json: { description: old },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [PLATFORM_IS_TOO_OLD] });
    expect(await call("add_platform", { owner: ana.username, slug: "worker", description: old }, ana.token)).toMatchObject({
      isError: true,
      text: PLATFORM_IS_TOO_OLD,
    });
    expect((await request("GET", `/api/v1/platforms/${ana.username}/worker`)).status).toBe(404);
  });

  it("takes a 0.8 one, and refuses a workflow sent as one", async () => {
    const ana = await person("ana");
    const pushTo = (slug: string, description: string) =>
      request("POST", `/api/v1/platforms/${ana.username}/${slug}/versions`, { as: { token: ana.token }, json: { description } });
    expect((await pushTo("worker", descriptions.worker)).status).toBe(201);
    const wrong = await pushTo("dinners", dinners);
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({
      errors: ["description: this is a workflow, not a platform description. Push it as a workflow."],
    });
  });

  it("takes one whose id is its own address, owner/platforms/slug, and refuses one that names another", async () => {
    const ana = await person("ana");
    const named = (id: string) =>
      descriptions.worker.replace("id: worker,", `id: ${id},`);
    const pushTo = (slug: string, description: string) =>
      request("POST", `/api/v1/platforms/${ana.username}/${slug}/versions`, { as: { token: ana.token }, json: { description } });
    expect((await pushTo("worker", named(`${ana.username}/platforms/worker`))).status).toBe(201);
    for (const id of [`${ana.username}/platforms/other`, "someone/platforms/worker"]) {
      const res = await pushTo("worker", named(id));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        errors: [`description: the platform id "${id}" must be ${ana.username}/platforms/worker, where it is pushed, or a bare id.`],
      });
    }
    expect((await request("GET", `/api/v1/platforms/${ana.username}/worker`).then((r) => r.json())).number).toBe(1);
  });
});

describe("a workflow's page", () => {
  it("draws the design on the security tab, and an implementation on the platform tab", async () => {
    const ana = await person("ana");
    const o = ana.username;
    expect((await push(o, "dinners", { token: ana.token }, { workflow: dinners })).status).toBe(201);
    const params = { owner: o, slug: "dinners" };

    const page = await renderPage(WorkflowPage, params);
    expect(page.status).toBe(200);
    expect(tabs(page.html)).toEqual([
      { href: `/${o}/dinners/security`, label: "Who may see each part", selected: true },
      { href: `/${o}/dinners/platform`, label: "Where each part runs", selected: false },
      { href: `/${o}/dinners/yaml`, label: "YAML", selected: false },
      { href: `/${o}/dinners/checks`, label: "Checks No mistakes", selected: false },
    ]);
    expect(drawing(page.html)).toEqual(expected(dinners));
    expect((await renderPage(WorkflowSecurityPage, params)).html).toBe(page.html);

    const platform = await renderPage(WorkflowPlatformPage, params);
    expect(platform.status).toBe(200);
    expect(drawing(platform.html)).toEqual(expected(dinners, "home"));
    expect(tabs(platform.html).find((t) => t.selected)?.href).toBe(`/${o}/dinners/platform`);
    // One implementation, so there is nothing to choose.
    expect(choice(platform.html)).toEqual([]);
    expect(text(platform.html)).toContain("At home");
    expect(text(platform.html)).toContain(`awml push ${o}/dinners workflow.yaml`);
  });

  it("orders the side panel as every workflow page does", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    await push(o, "dinners", { token: ana.token }, { workflow: twoPlaces });
    for (const page of [WorkflowPage, WorkflowPlatformPage]) {
      const shown = text((await renderPage(page, { owner: o, slug: "dinners" })).html);
      const at = ["Who decides", "Outside actions", "Leaves its scope", "Change it", "Everything in it"].map((h) =>
        shown.indexOf(h),
      );
      expect(at.every((i) => i >= 0), String(at)).toBe(true);
      expect(at).toEqual([...at].sort((x, y) => x - y));
    }
  });

  it("offers a choice of implementation when there is more than one, the first drawn by default", async () => {
    const ana = await person("ana");
    const o = ana.username;
    expect(await engine.check(twoPlaces)).toEqual([]);
    await push(o, "dinners", { token: ana.token }, { workflow: twoPlaces });
    const params = { owner: o, slug: "dinners" };

    const first = await renderPage(WorkflowPlatformPage, params);
    expect(choice(first.html)).toEqual([
      { href: `/${o}/dinners/platform/home`, label: "At home", current: true },
      { href: `/${o}/dinners/platform/away`, label: "Away for the summer", current: false },
    ]);
    expect(drawing(first.html)).toEqual(expected(twoPlaces, "home"));
    expect((await renderPage(ImplementationPage, { ...params, implementation: "home" })).html).toBe(first.html);

    const away = await renderPage(ImplementationPage, { ...params, implementation: "away" });
    expect(away.status).toBe(200);
    expect(drawing(away.html)).toEqual(expected(twoPlaces, "away"));
    expect(choice(away.html).map((c) => c.current)).toEqual([false, true]);
    expect(tabs(away.html).find((t) => t.selected)?.href).toBe(`/${o}/dinners/platform`);

    expect((await renderPage(ImplementationPage, { ...params, implementation: "nowhere" })).status).toBe(404);
  });

  it("keeps an older version's implementations at that version's addresses", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: twoPlaces });
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const v1 = { owner: o, slug: "dinners", n: "1" };
    const away = await renderPage(VersionImplementationPage, { ...v1, implementation: "away" });
    expect(away.status).toBe(200);
    expect(drawing(away.html)).toEqual(expected(twoPlaces, "away"));
    expect(choice(away.html).map((c) => c.href)).toEqual([`/${o}/dinners/v/1/platform/home`, `/${o}/dinners/v/1/platform/away`]);
    expect(tabs(away.html).map((t) => t.href)).toEqual([
      `/${o}/dinners/v/1/security`,
      `/${o}/dinners/v/1/platform`,
      `/${o}/dinners/v/1/yaml`,
      `/${o}/dinners/v/1/checks`,
    ]);
    expect(drawing((await renderPage(VersionPlatformPage, v1)).html)).toEqual(expected(twoPlaces, "home"));
    // The latest version has only home.
    expect((await renderPage(ImplementationPage, { owner: o, slug: "dinners", implementation: "away" })).status).toBe(404);
  });

  it("says so on the platform tab when the workflow doesn't say where it runs yet", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: nowhere });
    const page = await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" });
    expect(page.status).toBe(200);
    expect(text(page.html)).toContain("This workflow doesn't say where it runs yet.");
    expect(drawing(page.html)).toBeNull();
    expect(tabs(page.html).map((t) => t.label)).toEqual(["Who may see each part", "Where each part runs", "YAML", "Checks No mistakes"]);
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html)).toEqual(expected(nowhere));
  });

  it("shows the one file on the YAML tab, with its download", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const page = await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" });
    expect(files(page.html)).toEqual({ "workflow-yaml": dinners });
    expect(text(page.html)).toContain("workflow.yaml Copy Download");
    expect(page.html).toContain(`<a href="/${o}/dinners/v/1/workflow.yaml" class="button outline" download="">Download</a>`);
    const raw = await request("GET", `/${o}/dinners/v/1/workflow.yaml`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-disposition")).toBe('inline; filename="dinners-v1-workflow.yaml"');
    expect(await raw.text()).toBe(dinners);
    expect((await request("GET", `/${o}/dinners/v/1/security.yaml`)).status).toBe(404);
    expect(files((await renderPage(VersionYamlPage, { owner: o, slug: "dinners", n: "1" })).html)).toEqual({ "workflow-yaml": dinners });
  });

  it("checks the one file with AWML 0.8 on the Checks tab", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    for (const page of [
      await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" }),
      await renderPage(VersionChecksPage, { owner: o, slug: "dinners", n: "1" }),
    ]) {
      expect(page.status).toBe(200);
      expect(text(page.html)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} The file is YAML file.yaml Passed`);
      expect(text(page.html)).not.toContain("security.yaml");
    }
    expect(engine.version.tag).toMatch(/^v0\.8\./);
  });
});

describe("warnings on the Checks tab", () => {
  // What `awml check` printed for test/fixtures/warning-08.yaml: its warnings, then ok.
  const printed = example("warning-08.check.txt").trim().split("\n");
  const warnings = printed.filter((l) => l.includes(": warning: ")).map((l) => l.replace(/^warning-08\.yaml: warning: /, ""));

  it("gives the warnings the native awml gives", async () => {
    expect(printed.at(-1)).toBe("warning-08.yaml: ok");
    expect(warnings).toHaveLength(1);
    expect(await engine.warnings(example("warning-08.yaml"))).toEqual(warnings);
    expect(await engine.warnings(dinners)).toEqual([]);
  });

  it("lists them apart from the mistakes, and they neither refuse a push nor fail the check", async () => {
    const ana = await person("ana");
    const o = ana.username;
    expect((await push(o, "basket", { token: ana.token }, { workflow: example("warning-08.yaml") })).status).toBe(201);
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "basket" });
    expect(tabs(page.html).at(-1)).toEqual({ href: `/${o}/basket/checks`, label: "Checks No mistakes", selected: true });
    expect(text(page.html)).toContain(
      "No do step is decided by AI warn.do-by-code 1 warning " +
        "A do step should be code acting on what an earlier step decided; this warns and never fails. " +
        `Warnings don't fail the check. ${warnings[0]}`,
    );
    // The design is still drawn.
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "basket" })).html)).toEqual(expected(example("warning-08.yaml")));
    // A file without warnings says nothing of them.
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    expect(text((await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" })).html)).not.toContain("warning");
  });
});

describe("every check on the Checks tab", () => {
  // The list stored with the only version there is.
  const stored = async () => (await (await getDb()).select({ checks: version.checks }).from(version))[0].checks;
  const bad = example("bad-08.yaml");
  const badMessages = example("bad-08.check.txt")
    .trim()
    .split("\n")
    .map((l) => l.replace(/^bad-08\.yaml: /, ""));

  it("gets each check from AWML in its spec's order, with a stable id, a name, what it guards and its result", async () => {
    const list = await engine.checks(dinners);
    expect(list.map((c) => c.id).slice(0, 3)).toEqual(["file.yaml", "file.version", "fields.known"]);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    expect(list[0]).toEqual({
      id: "file.yaml",
      name: "The file is YAML",
      about: "Each file can be read, and holds a YAML mapping of fields.",
      result: "pass",
      mistakes: [],
    });
    expect(list.find((c) => c.id === "description.ids")).toMatchObject({
      result: "skipped",
      skippedBecause: "no file given is a platform description",
    });

    // The checks that fail give the mistakes awml check prints, and a warning is a warning.
    const failed = (await engine.checks(bad)).filter((c) => c.result === "fail");
    expect(failed.map((c) => c.id)).toEqual(["references.known", "placement.complete"]);
    expect(failed.flatMap((c) => c.mistakes)).toEqual(badMessages);
    const warned = (await engine.checks(example("warning-08.yaml"))).filter((c) => c.result === "warn");
    expect(warned.map((c) => [c.id, c.mistakes])).toEqual([
      ["warn.do-by-code", [await engine.warnings(example("warning-08.yaml")).then((w) => w[0])]],
    ]);
  });

  it("stores the list with each version at push time, with the AWML that made it, through the API and MCP", async () => {
    const ana = await person("ana");
    expect((await push(ana.username, "dinners", { token: ana.token }, { workflow: dinners })).status).toBe(201);
    expect(await stored()).toEqual({ awml: engine.version, checks: await engine.checks(dinners) });

    const bea = await person("bea");
    const published = await call("publish", { owner: bea.username, slug: "basket", workflow: twoPlaces }, bea.token);
    expect(published).toMatchObject({ isError: false });
    const all = await (await getDb()).select({ checks: version.checks }).from(version);
    expect(all.map((v) => v.checks)).toEqual([
      { awml: engine.version, checks: await engine.checks(dinners) },
      { awml: engine.version, checks: await engine.checks(twoPlaces) },
    ]);
    // The API's answer is as it was.
    const answer = await (await request("GET", `/api/v1/${ana.username}/dinners/v/1`)).json();
    expect(Object.keys(answer)).not.toContain("checks");
  });

  it("shows one row per check, each with its name, id, result and what it guards, and a tick on its tab", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const list = await engine.checks(dinners);
    for (const page of [
      await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" }),
      await renderPage(VersionChecksPage, { owner: o, slug: "dinners", n: "1" }),
    ]) {
      expect(page.status).toBe(200);
      expect(tabs(page.html).at(-1)?.label).toBe("Checks No mistakes");
      expect(checkIds(page.html)).toEqual(list.map((c) => c.id));
      const shown = text(page.html);
      expect(shown).toContain(
        `AWML checked this file when it was pushed, and the registry refuses a push with any mistake. ` +
          `Here is each check it ran, in the order its spec gives them. ` +
          `workflow.yaml Checked by AWML ${engine.version.tag} `,
      );
      expect(new Set(list.map((c) => c.result))).toEqual(new Set(["pass", "skipped"]));
      for (const c of list)
        expect(shown, c.id).toContain(
          c.result === "pass"
            ? `${c.name} ${c.id} Passed ${c.about}`
            : `${c.name} ${c.id} Skipped ${c.about} Skipped because ${c.skippedBecause}.`,
        );
      expect(shown).not.toContain("awml check No mistakes");
      expect(shown).not.toContain("not each rule it checks");
    }
  });

  it("marks a warning as a warning, which keeps the tick", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "basket", { token: ana.token }, { workflow: example("warning-08.yaml") });
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "basket" });
    expect(tabs(page.html).at(-1)?.label).toBe("Checks No mistakes");
    expect(page.html).toContain('<span class="badge warn">1 warning</span>');
    expect(text(page.html)).not.toContain("Passed 1 warning");
  });

  it("keeps the tab's tick only when no check failed, and a file whose list failed is not drawn", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const list = (await stored())!;
    const failed = {
      ...list,
      checks: list.checks.map((c) => (c.id === "references.known" ? { ...c, result: "fail" as const, mistakes: ["it names nothing"] } : c)),
    };
    await (await getDb()).update(version).set({ checks: failed });

    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(tabs(page.html).at(-1)?.label).toBe("Checks 1 mistake");
    expect(text(page.html)).toContain("Every reference names something in the file references.known 1 mistake");
    expect(text(page.html)).toContain("it names nothing");
    const drawn = await renderPage(WorkflowPage, { owner: o, slug: "dinners" });
    expect(drawing(drawn.html)).toBeNull();
    expect(text(drawn.html)).toContain("workflow.yaml has 1 mistake, so it cannot be drawn. See Checks.");
  });

  it("names the AWML that made the list, not the one the registry runs now", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const list = (await stored())!;
    await (await getDb()).update(version).set({ checks: { ...list, awml: { tag: "v0.5.0", commit: "0123abc" } } });
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(text(page.html)).toContain("workflow.yaml Checked by AWML v0.5.0 ");
    expect(page.html).toContain('href="https://github.com/chrismdp/awml/blob/0123abc/SPEC.md#the-file-format"');
  });

  it("lists every check now, with the AWML the registry runs, for a version stored with no list, and never stores it", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    await (await getDb()).update(version).set({ checks: null });
    const list = await engine.checks(dinners);
    for (const page of [
      await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" }),
      await renderPage(VersionChecksPage, { owner: o, slug: "dinners", n: "1" }),
    ]) {
      expect(page.status).toBe(200);
      expect(checkIds(page.html)).toEqual(list.map((c) => c.id));
      const shown = text(page.html);
      expect(shown).toContain(
        `AWML checked this file when it was pushed, and the registry refuses a push with any mistake. ` +
          `It is checked again here, by the AWML this registry runs. Here is each check it ran, in the order its spec gives them. ` +
          `workflow.yaml Checked by AWML ${engine.version.tag} `,
      );
      for (const c of list.filter((c) => c.result === "pass")) expect(shown, c.id).toContain(`${c.name} ${c.id} Passed ${c.about}`);
      expect(shown).not.toContain("awml check No mistakes");
      expect(shown).not.toContain("not each rule it checks");
      expect(page.html).toContain(`href="https://github.com/chrismdp/awml/blob/${engine.version.commit}/SPEC.md#the-file-format"`);
      expect(tabs(page.html).at(-1)?.label).toBe("Checks No mistakes");
    }
    // The list made now is never written back into the old version.
    expect(await stored()).toBeNull();
  });

  it("keeps showing a stored list as stored, with the AWML that made it, beside a version listed now", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    await push(o, "dinners", { token: ana.token }, { workflow: twoPlaces });
    const db = await getDb();
    const [first] = await db.select({ id: version.id, checks: version.checks }).from(version).where(eq(version.number, 1));
    await db.update(version).set({ checks: { ...first.checks!, awml: { tag: "v0.5.0", commit: "0123abc" } } }).where(eq(version.id, first.id));
    await db.update(version).set({ checks: null }).where(eq(version.number, 2));

    const old = text((await renderPage(VersionChecksPage, { owner: o, slug: "dinners", n: "1" })).html);
    expect(old).toContain("Here is each check it ran, in the order its spec gives them. workflow.yaml Checked by AWML v0.5.0 ");
    expect(old).not.toContain("checked again here");
    const now = text((await renderPage(VersionChecksPage, { owner: o, slug: "dinners", n: "2" })).html);
    expect(now).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
  });

  it("shows each check that fails in a version stored with no list, with no tick on its tab", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    // Only a newer AWML finding mistakes in a stored file can be like this.
    await (await getDb()).update(version).set({ workflow: bad, checks: null });
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(tabs(page.html).at(-1)?.label).toBe("Checks 2 mistakes");
    expect(checkIds(page.html)).toEqual((await engine.checks(bad)).map((c) => c.id));
    const shown = text(page.html);
    expect(shown).toContain(`Every reference names something in the file references.known 1 mistake`);
    expect(shown).toContain(badMessages[0]);
    expect(shown).toContain(badMessages[1]);
    expect(shown).not.toContain("awml check");
    expect(shown).not.toContain("not each rule it checks");
    const drawn = await renderPage(WorkflowPage, { owner: o, slug: "dinners" });
    expect(text(drawn.html)).toContain("workflow.yaml has 2 mistakes, so it cannot be drawn. See Checks.");
  });

  it("lists the checks now when the AWML the registry runs finds mistakes the stored list did not", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    await (await getDb()).update(version).set({ workflow: bad });
    const page = await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" });
    expect(tabs(page.html).at(-1)?.label).toBe("Checks 2 mistakes");
    expect(checkIds(page.html)).toEqual((await engine.checks(bad)).map((c) => c.id));
    expect(text(page.html)).toContain(`It is checked again here, by the AWML this registry runs.`);
    expect(text(page.html)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
    // The stored list is left as it was.
    expect(await stored()).toEqual({ awml: engine.version, checks: await engine.checks(dinners) });
  });
});

describe("workflows in the gallery and an inventory", () => {
  it("draw the design on a gallery card", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { workflow: dinners });
    expect(drawing((await renderPage(GalleryPage, {})).html)).toEqual(expected(dinners));
  });

  it("say where they run by their implementations' blocks, or that they don't say yet", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    await push("acme", "dinners", { token: olive.token }, { workflow: dinners });
    await push("acme", "nowhere", { token: olive.token }, { workflow: nowhere.replace("The family's dinners", "Dinners, nowhere") });
    const shown = text((await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } })).html);
    expect(shown).toContain("1 of 2 don't say where they run yet");
    expect(shown).toContain("carers family Server: claude-sonnet-4-5 The family messaging app The kitchen screen");
    expect(shown).toContain("Dinners, nowhere Public · 1 line leaves a scope 1 of 1 step Plan next week's dinners");
    expect(shown).toContain("carers family No platform view yet");
  });
});

describe("fitting a workflow", () => {
  type FitResult = { platform: string; judged: boolean; fits: boolean; reasons: string[]; models: Record<string, string[]> };
  const native = JSON.parse(example("client-email.fit.json")) as { results: FitResult[]; gaps: string[] };
  const nativeFor = (id: string) => {
    const { platform: _, ...rest } = native.results.find((r) => r.platform === id)!;
    return rest;
  };
  // The office implementation with its Mac mini block placed on a named description.
  const placed = clientEmail.replace(
    '{ id: cowork, label: "Claude Cowork, Mac mini", parts',
    '{ id: cowork, label: "Claude Cowork, Mac mini", platform: scripts-mac-mini, parts',
  );

  async function ana() {
    const ana = await person("ana");
    for (const id of ids) {
      const res = await request("POST", `/api/v1/platforms/${ana.username}/${id}/versions`, {
        as: { token: ana.token },
        json: { description: descriptions[id] },
      });
      expect(res.status).toBe(201);
    }
    expect((await push(ana.username, "client-email", { token: ana.token }, { workflow: placed })).status).toBe(201);
    return ana;
  }

  const fit = async (body: unknown, as?: Who) => {
    const res = await request("POST", "/api/v1/fit", { as, json: body });
    return { status: res.status, body: await res.json() };
  };

  it("judges the design of a stored workflow, or of one sent as file, as the native fit does", async () => {
    const { username } = await ana();
    for (const body of [{ workflow: `${username}/client-email` }, { file: clientEmail }]) {
      const res = await fit({ ...body, platforms: [`${username}/worker`, `${username}/scripts-mac-mini`] });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { platform: `${username}/worker`, number: 1, id: "worker", label: "A code worker", ...nativeFor("worker") },
        {
          platform: `${username}/scripts-mac-mini`,
          number: 1,
          id: "scripts-mac-mini",
          label: "Scheduled scripts on a Mac mini",
          ...nativeFor("scripts-mac-mini"),
        },
      ]);
    }
  });

  it("judges an implementation's placement, each block against the platform it names", async () => {
    const { username } = await ana();
    const expected = (await engine.fit(placed, [descriptions["scripts-mac-mini"]], "office")).results;
    expect(expected.map((r) => [r.platform, r.judged])).toEqual([
      ["cowork", true],
      ["files", false],
      ["phone", false],
      ["gmail", false],
    ]);
    const res = await fit({ workflow: `${username}/client-email`, implementation: "office" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workflow: { owner: username, slug: "client-email", number: 1 },
      implementation: "office",
      results: expected.map(({ platform: block, ...answer }) =>
        block === "cowork"
          ? { block, platform: `${username}/scripts-mac-mini`, number: 1, id: "scripts-mac-mini", label: "Scheduled scripts on a Mac mini", ...answer }
          : { block, platform: null, number: null, id: null, label: null, ...answer },
      ),
      gaps: [],
    });
    // Unplaced, the native fit judges no block.
    const unplaced = await fit({ file: clientEmail, implementation: "office", platforms: [] });
    expect(unplaced.body.results.map((r: { block: string; judged: boolean }) => [r.block, r.judged])).toEqual(
      JSON.parse(example("client-email-office.fit.json")).results.map((r: FitResult) => [r.platform, r.judged]),
    );
  });

  it("gives a gap when a block names a platform the caller cannot see", async () => {
    const { username } = await ana();
    const res = await fit({ workflow: `${username}/client-email`, implementation: "office", platforms: [`${username}/worker`] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.gaps).toEqual(['group "cowork" names platform "scripts-mac-mini", but its description wasn\'t given']);
  });

  it("refuses an implementation the workflow doesn't have, and an older file", async () => {
    const { username } = await ana();
    expect(await fit({ workflow: `${username}/client-email`, implementation: "home" })).toEqual({
      status: 422,
      body: { errors: [`${username}/client-email v1 has no implementation "home".`] },
    });
    expect(await fit({ file: clientEmail03 })).toEqual({ status: 400, body: { errors: [WORKFLOW_IS_TOO_OLD] } });
    expect(await fit({ security: clientEmail03 })).toEqual({ status: 400, body: { errors: [WORKFLOW_IS_TOO_OLD] } });
  });

  it("takes the file and an implementation through the MCP fit tool", async () => {
    const a = await ana();
    const answer = await call("fit_workflow", { file: placed, implementation: "office" }, a.token);
    expect(answer.isError).toBe(false);
    expect(answer.data.implementation).toBe("office");
    expect(answer.text).toContain(`cowork on ${a.username}/scripts-mac-mini v1 fits`);
    expect(answer.text).toContain("files isn't judged: it names no platform");
  });

  describe("a block that names a registered platform as owner/platforms/slug", () => {
    const placedAt = (platform: string, file = clientEmail) =>
      file.replace(
        '{ id: cowork, label: "Claude Cowork, Mac mini", parts',
        `{ id: cowork, label: "Claude Cowork, Mac mini", platform: ${platform}, parts`,
      );
    // Acme's ops runner: the Mac mini's description, under a bare id.
    const opsRunner = descriptions["scripts-mac-mini"].replace("id: scripts-mac-mini,", "id: ops-runner,");
    // What the native fit says of the Mac mini block on that description.
    const native = async () => {
      const [{ platform: _, ...answer }] = (await engine.fit(placedAt("ops-runner"), [opsRunner], "office")).results;
      expect(answer.judged).toBe(true);
      return answer;
    };

    async function acme(description = opsRunner) {
      const olive = await person("olive");
      await orgWith("acme", olive);
      const res = await request("POST", "/api/v1/platforms/acme/ops-runner/versions", {
        as: { token: olive.token },
        json: { description },
      });
      expect(res.status).toBe(201);
      return olive;
    }

    it("serves acme/platforms/ops-runner at /api/v1/acme/platforms/ops-runner, where awml pull asks for it", async () => {
      const olive = await acme();
      for (const [pull, old] of [
        ["/api/v1/acme/platforms/ops-runner", "/api/v1/platforms/acme/ops-runner"],
        ["/api/v1/acme/platforms/ops-runner/v/1", "/api/v1/platforms/acme/ops-runner/v/1"],
      ]) {
        const res = await request("GET", pull, { as: { token: olive.token } });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ owner: "acme", slug: "ops-runner", number: 1, description: opsRunner });
        expect(body).toEqual(await (await request("GET", old, { as: { token: olive.token } })).json());
      }
    });

    it("fits a workflow's block named acme/platforms/ops-runner against acme's stored ops-runner, with no network", async () => {
      const olive = await acme();
      const file = placedAt("acme/platforms/ops-runner");
      expect(file).toMatch(/^awml: "0\.8"$/m);
      expect(await engine.check(file)).toEqual([]);
      const expected = {
        block: "cowork",
        platform: "acme/ops-runner",
        number: 1,
        id: "acme/platforms/ops-runner",
        label: "Scheduled scripts on a Mac mini",
        ...(await native()),
      };
      for (const body of [
        { file, implementation: "office" },
        { file, implementation: "office", platforms: ["acme/ops-runner"] },
      ]) {
        const res = await fit(body, { token: olive.token });
        expect(res.status).toBe(200);
        expect(res.body.gaps).toEqual([]);
        expect(res.body.results[0]).toEqual(expected);
      }
      // And so does a stored workflow.
      expect((await push("acme", "client-email", { token: olive.token }, { workflow: file })).status).toBe(201);
      const stored = await fit({ workflow: "acme/client-email", implementation: "office" });
      expect(stored.body.results[0]).toEqual(expected);
    });

    it("fits it against a stored description whose own id is acme/platforms/ops-runner", async () => {
      await acme(opsRunner.replace("id: ops-runner,", "id: acme/platforms/ops-runner,"));
      const res = await fit({ file: placedAt("acme/platforms/ops-runner"), implementation: "office" });
      expect(res.body.results[0]).toEqual({
        block: "cowork",
        platform: "acme/ops-runner",
        number: 1,
        id: "acme/platforms/ops-runner",
        label: "Scheduled scripts on a Mac mini",
        ...(await native()),
      });
    });

    it("takes an owner that starts with a digit: 42labs pushes a description and a block fits it", async () => {
      const olive = await person("olive");
      await orgWith("42labs", olive);
      const id = "42labs/platforms/ops-runner";
      const description = opsRunner.replace("id: ops-runner,", `id: ${id},`);
      const pushed = await request("POST", "/api/v1/platforms/42labs/ops-runner/versions", {
        as: { token: olive.token },
        json: { description },
      });
      expect(pushed.status).toBe(201);
      const file = placedAt(id);
      expect(await engine.check(file)).toEqual([]);
      const res = await fit({ file, implementation: "office" });
      expect(res.status).toBe(200);
      expect(res.body.gaps).toEqual([]);
      expect(res.body.results[0]).toMatchObject({ block: "cowork", platform: "42labs/ops-runner", number: 1, id, judged: true });
    });

    it("fits a block by the description's bare id", async () => {
      await acme();
      const file = placedAt("ops-runner");
      expect(await engine.check(file)).toEqual([]);
      const res = await fit({ file, implementation: "office" });
      expect(res.body.results[0]).toEqual({
        block: "cowork",
        platform: "acme/ops-runner",
        number: 1,
        id: "ops-runner",
        label: "Scheduled scripts on a Mac mini",
        ...(await native()),
      });
    });

    it("fits it against a description stored in AWML 0.5, converted when read", async () => {
      const olive = await person("olive");
      await orgWith("acme", olive);
      await storePlatformVersion("acme", "ops-runner", olive, example("older/scripts-mac-mini-05.yaml").replace("id: scripts-mac-mini,", "id: ops-runner,"));
      for (const named of ["acme/platforms/ops-runner", "ops-runner"]) {
        const res = await fit({ file: placedAt(named), implementation: "office" });
        expect(res.body.results[0], named).toEqual({
          block: "cowork",
          platform: "acme/ops-runner",
          number: 1,
          id: named,
          label: "Scheduled scripts on a Mac mini",
          ...(await native()),
        });
      }
    });

    it("gives the engine's gap, saying to pull it, when no such platform is stored", async () => {
      await acme();
      const res = await fit({ file: placedAt("acme/platforms/nothing-here"), implementation: "office" });
      expect(res).toEqual({
        status: 200,
        body: {
          workflow: null,
          implementation: "office",
          results: [],
          gaps: [
            'group "cowork" names platform "acme/platforms/nothing-here", but its description wasn\'t given: pull it with awml pull acme/platforms/nothing-here',
          ],
        },
      });
    });
  });
});

describe("versions stored before the registry took only 0.4 files", () => {
  it("stay readable, converted when read: their pages, each tab, their YAML, Checks and raw files, beside a 0.8 version", async () => {
    const ana = await person("ana");
    const o = ana.username;
    await storeVersion(o, "dinners", ana, { security: legacySecurity, platform: legacyPlatform }, { summary: JSON.parse(example("legacy/dinners.summary.json")) });
    await storeVersion(o, "dinners", ana, { security: clientEmail03 });
    await push(o, "dinners", { token: ana.token }, { workflow: dinners });
    const v1 = { owner: o, slug: "dinners", n: "1" };

    const page = await renderPage(VersionPage, v1);
    expect(page.status).toBe(200);
    expect(drawing(page.html)).toEqual(await expectedOf([legacySecurity]));
    expect(tabs(page.html).map((t) => t.href)).toEqual([
      `/${o}/dinners/v/1/security`,
      `/${o}/dinners/v/1/platform`,
      `/${o}/dinners/v/1/yaml`,
      `/${o}/dinners/v/1/checks`,
    ]);
    // This pair's views differ, so AWML 0.8 can't join them, and its platform
    // view can't be converted: the tab says so, and Checks gives convert's reasons.
    const platform = await renderPage(VersionPlatformPage, v1);
    const reasons = await engine.convert([legacySecurity, legacyPlatform]);
    if (!("error" in reasons)) throw new Error("the dinners pair converted");
    const why = reasons.error.split("\n");
    expect(drawing(platform.html)).toBeNull();
    expect(text(platform.html)).toContain(`platform.yaml has ${why.length} mistakes, so it cannot be drawn. See Checks.`);
    expect(choice(platform.html)).toEqual([]);
    expect((await renderPage(VersionImplementationPage, { ...v1, implementation: "default" })).status).toBe(404);
    const yaml = (await renderPage(VersionYamlPage, v1)).html;
    expect(files(yaml)).toEqual({
      "security-yaml": legacySecurity,
      "platform-yaml": legacyPlatform,
    });
    expect(text(yaml)).toContain("security.yaml is AWML 0.2, as it was pushed. The registry draws, checks and fits it converted to AWML 0.8.");
    // AWML 0.7 warns of what the converted security view starts with no trigger, which fails nothing.
    const converted = await engine.convert([legacySecurity]);
    const warned = "file" in converted ? await engine.warnings(converted.file) : [];
    expect(warned.length).toBeGreaterThan(0);
    expect(text((await renderPage(VersionChecksPage, v1)).html)).toContain(
      `security.yaml Checked by AWML ${engine.version.tag} awml check No mistakes ${warned.length} warnings Warnings don't fail the check. ${warned.join(" ")} ` +
        `platform.yaml Checked by AWML ${engine.version.tag} awml convert ${why.length} mistakes ${why.join(" ")}`,
    );
    expect(await (await request("GET", `/${o}/dinners/v/1/security.yaml`)).text()).toBe(legacySecurity);
    expect(await (await request("GET", `/${o}/dinners/v/1/platform.yaml`)).text()).toBe(legacyPlatform);
    expect((await request("GET", `/${o}/dinners/v/1/workflow.yaml`)).status).toBe(404);

    const stored = await (await request("GET", `/api/v1/${o}/dinners/v/1`)).json();
    expect(stored.files).toEqual({ security: legacySecurity, platform: legacyPlatform });
    expect(stored.summary).toEqual(JSON.parse(example("legacy/dinners.summary.json")));

    // Version 2, a 0.3 security view alone, has no platform tab.
    const v2 = await renderPage(VersionPage, { ...v1, n: "2" });
    expect(tabs(v2.html).map((t) => t.label)).toEqual(["Who may see each part", "YAML", "Checks No mistakes"]);
    expect((await renderPage(VersionPlatformPage, { ...v1, n: "2" })).status).toBe(404);

    // The latest, 0.8, sits beside them.
    const latest = await renderPage(WorkflowPage, { owner: o, slug: "dinners" });
    expect(text(latest.html)).toContain("Version 3 of 3");
    expect(drawing(latest.html)).toEqual(expected(dinners));
  });

  it("draws a platform view joined with its security view, when the two agree", async () => {
    const ana = await person("ana");
    const o = ana.username;
    const pair = { security: example("legacy/bin-day-security.yaml"), platform: example("legacy/bin-day-platform.yaml") };
    await storeVersion(o, "bin-day", ana, pair);
    const platform = await renderPage(WorkflowPlatformPage, { owner: o, slug: "bin-day" });
    expect(drawing(platform.html)).toEqual(await expectedOf([pair.security, pair.platform], "default"));
    expect(tabs(platform.html).at(-1)?.label).toBe("Checks No mistakes");
    expect(files((await renderPage(WorkflowYamlPage, { owner: o, slug: "bin-day" })).html)).toEqual({
      "security-yaml": pair.security,
      "platform-yaml": pair.platform,
    });
  });

  it("can still be fitted by name", async () => {
    const ana = await person("ana");
    await request("POST", `/api/v1/platforms/${ana.username}/worker/versions`, {
      as: { token: ana.token },
      json: { description: descriptions.worker },
    });
    await storeVersion(ana.username, "client-email", ana, { security: clientEmail03 });
    const res = await request("POST", "/api/v1/fit", { json: { workflow: `${ana.username}/client-email` } });
    expect(res.status).toBe(200);
    expect((await res.json()).results[0]).toMatchObject({ platform: `${ana.username}/worker`, judged: true });
  });
});

describe("a private workflow's implementations", () => {
  // Org "acme": owner Olive and member Mo, with a private workflow in two
  // places. Org "beta": Bea. Nell belongs to nothing.
  async function setUp() {
    const olive = await person("olive");
    const mo = await person("mo");
    const bea = await person("bea");
    const nell = await person("nell");
    await orgWith("acme", olive, [mo]);
    await orgWith("beta", bea);
    expect((await push("acme", "payroll", { token: olive.token }, { workflow: twoPlaces, visibility: "private" })).status).toBe(201);
    return { olive, mo, bea, nell };
  }

  const pages = [
    [ImplementationPage, { owner: "acme", slug: "payroll", implementation: "away" }],
    [VersionImplementationPage, { owner: "acme", slug: "payroll", n: "1", implementation: "away" }],
    [WorkflowPlatformPage, { owner: "acme", slug: "payroll" }],
    [WorkflowYamlPage, { owner: "acme", slug: "payroll" }],
  ] as const;

  it("shows them to the organisation's owner and members", async () => {
    const { olive, mo } = await setUp();
    for (const as of [olive, mo]) {
      for (const [page, params] of pages) expect((await renderPage(page as never, params, { as })).status).toBe(200);
      expect((await request("GET", "/acme/payroll/v/1/workflow.yaml", { as: { token: as.token } })).status).toBe(200);
      const fitted = await request("POST", "/api/v1/fit", { as: { token: as.token }, json: { workflow: "acme/payroll", implementation: "away" } });
      expect(fitted.status).toBe(200);
    }
  });

  it("is not found to a stranger, a signed-out visitor or another organisation's member", async () => {
    const { bea, nell } = await setUp();
    for (const as of [undefined, nell, bea]) {
      for (const [page, params] of pages) expect((await renderPage(page as never, params, { as })).status).toBe(404);
      const who = as ? { token: as.token } : undefined;
      expect((await request("GET", "/acme/payroll/v/1/workflow.yaml", { as: who })).status).toBe(404);
      const fitted = await request("POST", "/api/v1/fit", { as: who, json: { workflow: "acme/payroll", implementation: "away" } });
      expect(fitted.status).toBe(404);
      expect(await fitted.json()).toEqual({ errors: ["Not found: acme/payroll."] });
      // A missing implementation looks the same as a missing workflow.
      const missing = await renderPage(ImplementationPage, { owner: "acme", slug: "payroll", implementation: "nowhere" }, { as });
      expect(missing.status).toBe(404);
    }
  });
});
