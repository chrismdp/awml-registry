// From AWML 0.6 the registry takes only 0.6 files, workflows and platform
// descriptions both, and refuses an older push with a 400 naming
// `awml convert`. Versions stored in an older AWML are never rewritten: each
// is converted with the engine's `convert` whenever it is read, so it still
// shows, checks, draws and fits, while its YAML and raw file are the bytes
// that were pushed. Checks stored at push stay as stored.
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { platformVersion, version } from "@/db/schema";
import { engine } from "@/engine";
import { PLATFORM_IS_TOO_OLD, WORKFLOW_IS_TOO_OLD } from "@/server/awml-file";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import GalleryPage from "@/app/gallery/page";
import PlatformPage from "@/app/[owner]/platforms/[slug]/page";
import PlatformYamlPage from "@/app/[owner]/platforms/[slug]/yaml/page";
import { example, person, request, storePlatformVersion, storeVersion, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage } from "./pages";

// As they were pushed: a 0.4 workflow, a 0.5 one, and a 0.5 platform
// description that the 0.5 workflow's office implementation names.
const dinners04 = example("older/dinners-04.yaml");
const clientEmail05 = example("older/client-email-05.yaml");
const macMini05 = example("older/scripts-mac-mini-05.yaml");
// What AWML 0.5.1 worked out for each workflow at push.
const stored = (name: string) => ({
  summary: JSON.parse(example(`older/${name}.summary.json`)),
  checks: JSON.parse(example(`older/${name}.checks.json`)),
});
const dinners = example("dinners.yaml"); // 0.6
const worker = example("platforms/worker.yaml"); // 0.6

const unescape = (html: string) =>
  html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const drawing = (html: string) => {
  const found = /<div class="drawing"><pre>([^]*?)<\/pre>/.exec(html);
  return found ? unescape(found[1]) : null;
};
const files = (html: string) =>
  Object.fromEntries([...html.matchAll(/<pre id="([^"]+)">([^]*?)<\/pre>/g)].map(([, id, body]) => [id, unescape(body)]));
const checkIds = (html: string) => [...html.matchAll(/<li data-check="([^"]+)"/g)].map((m) => m[1]);
// What `awml check --json` lists for a converted file, by id.
const listedNow = (name: string) =>
  (JSON.parse(example(`older/${name}.checks-now.json`)) as { checks: { id: string }[] }).checks.map((c) => c.id);

async function push(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: body });
  return { status: res.status, body: await res.json() };
}

const fit = async (body: unknown, as?: Who) => {
  const res = await request("POST", "/api/v1/fit", { as, json: body });
  return { status: res.status, body: await res.json() };
};

// Each workflow version's and platform version's stored files, straight from
// the database.
async function storedBytes() {
  const db = await getDb();
  return {
    workflows: (await db.select({ workflow: version.workflow }).from(version)).map((v) => v.workflow),
    descriptions: (await db.select({ description: platformVersion.description }).from(platformVersion)).map((v) => v.description),
  };
}

describe("pushing", () => {
  it("takes a 0.6 workflow and a 0.6 platform description", async () => {
    const ana = await person("ana");
    expect(dinners).toMatch(/^awml: "0\.6"$/m);
    expect(await push(ana.username, "dinners", { token: ana.token }, { workflow: dinners })).toMatchObject({ status: 201 });
    const published = await call("publish", { owner: ana.username, slug: "dinners", workflow: dinners }, ana.token);
    expect(published).toMatchObject({ isError: false, data: { number: 2 } });
    expect(worker).toMatch(/^awml: "0\.6"$/m);
    const res = await request("POST", `/api/v1/platforms/${ana.username}/worker/versions`, {
      as: { token: ana.token },
      json: { description: worker },
    });
    expect(res.status).toBe(201);
  });

  it("refuses a 0.4 or 0.5 workflow with a 400 naming awml convert, through the API, MCP and the fit", async () => {
    const ana = await person("ana");
    expect(WORKFLOW_IS_TOO_OLD).toBe(
      "This registry takes AWML 0.6 files. Upgrade yours with `awml convert workflow.yaml > upgraded.yaml`, " +
        "or join a 0.3 pair with `awml convert security.yaml platform.yaml > upgraded.yaml`, and push that.",
    );
    for (const file of [dinners04, clientEmail05]) {
      expect(await push(ana.username, "dinners", { token: ana.token }, { workflow: file })).toEqual({
        status: 400,
        body: { errors: [WORKFLOW_IS_TOO_OLD] },
      });
      for (const tool of ["publish", "check"]) {
        const answer = await call(tool, { owner: ana.username, slug: "dinners", workflow: file }, ana.token);
        expect(answer, tool).toMatchObject({ isError: true, text: WORKFLOW_IS_TOO_OLD });
      }
      expect(await fit({ file })).toEqual({ status: 400, body: { errors: [WORKFLOW_IS_TOO_OLD] } });
    }
    expect((await request("GET", `/api/v1/${ana.username}/dinners`)).status).toBe(404);
  });

  it("refuses a 0.4 or 0.5 platform description with a 400 naming awml convert, through the API and MCP", async () => {
    const ana = await person("ana");
    expect(PLATFORM_IS_TOO_OLD).toBe(
      "This registry takes AWML 0.6 platform descriptions. Upgrade yours with `awml convert description.yaml > upgraded.yaml` and push that.",
    );
    for (const description of [macMini05, macMini05.replace('awml: "0.5"', 'awml: "0.4"')]) {
      const res = await request("POST", `/api/v1/platforms/${ana.username}/mac-mini/versions`, {
        as: { token: ana.token },
        json: { description },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ errors: [PLATFORM_IS_TOO_OLD] });
      expect(await call("add_platform", { owner: ana.username, slug: "mac-mini", description }, ana.token)).toMatchObject({
        isError: true,
        text: PLATFORM_IS_TOO_OLD,
      });
    }
    expect((await request("GET", `/api/v1/platforms/${ana.username}/mac-mini`)).status).toBe(404);
  });
});

describe("a stored 0.4 version, with no checks stored", () => {
  async function stored04() {
    const ana = await person("ana");
    await storeVersion(ana.username, "dinners", ana, { workflow: dinners04 }, { summary: stored("dinners-04").summary });
    return ana.username;
  }

  it("draws its design and its implementation converted to 0.6, as the native awml draws the converted file", async () => {
    const o = await stored04();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html)).toBe(
      example("older/dinners-04.mmd").trimEnd(),
    );
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" })).html)).toBe(
      example("older/dinners-04-home.mmd").trimEnd(),
    );
  });

  it("has its checks worked out when shown, through convert, by the AWML the registry runs", async () => {
    const o = await stored04();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" })).html;
    expect(checkIds(page)).toEqual(listedNow("dinners-04"));
    expect(text(page)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
    expect(text(page)).toContain("Checks No mistakes");
    expect((await storedBytes()).workflows).toEqual([dinners04]);
  });

  it("shows its stored bytes on the YAML tab, saying it is AWML 0.4 shown converted to 0.6, and serves them as the raw file", async () => {
    const o = await stored04();
    for (const page of [
      await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" }),
      await renderPage(VersionYamlPage, { owner: o, slug: "dinners", n: "1" }),
    ]) {
      expect(files(page.html)).toEqual({ "workflow-yaml": dinners04 });
      expect(text(page.html)).toContain(
        "workflow.yaml is AWML 0.4, as it was pushed. The registry draws, checks and fits it converted to AWML 0.6.",
      );
    }
    expect(await (await request("GET", `/${o}/dinners/v/1/workflow.yaml`)).text()).toBe(dinners04);
    expect((await (await request("GET", `/api/v1/${o}/dinners/v/1`)).json()).files).toEqual({ workflow: dinners04 });
    expect((await storedBytes()).workflows).toEqual([dinners04]);
  });

  it("fits through convert, giving the gaps the native fit gives the converted file", async () => {
    const o = await stored04();
    await storePlatformVersion(o, "scripts-mac-mini", { id: (await person("bea")).id }, macMini05);
    expect(await fit({ workflow: `${o}/dinners`, platforms: [`${o}/scripts-mac-mini`] })).toEqual({
      status: 200,
      body: { workflow: { owner: o, slug: "dinners", number: 1 }, implementation: null, results: [], gaps: JSON.parse(example("older/dinners-04.fit.json")).gaps },
    });
  });

  it("draws its design on a gallery card", async () => {
    await stored04();
    const html = unescape((await renderPage(GalleryPage, {})).html);
    expect(html).toContain(example("older/dinners-04.mmd").split("\n").slice(0, 6).join("\n"));
  });

  it("is forked as the converted 0.6 file, since a fork is a push", async () => {
    const o = await stored04();
    const bea = await person("bea");
    const res = await request("POST", `/api/v1/${o}/dinners/fork`, { as: { token: bea.token }, json: { owner: bea.username } });
    expect(res.status).toBe(201);
    const fork = (await (await request("GET", `/api/v1/${bea.username}/dinners/v/1`)).json()).files.workflow;
    expect(fork).toMatch(/^awml: "0\.6"$/m);
    expect(fork).not.toContain("kind: publish");
    expect((await storedBytes()).workflows).toEqual([dinners04, fork]);
  });
});

describe("a stored 0.5 version, with the checks stored at push, and a stored 0.5 platform description", () => {
  async function stored05() {
    const ana = await person("ana");
    await storeVersion(ana.username, "client-email", ana, { workflow: clientEmail05 }, stored("client-email-05"));
    await storePlatformVersion(ana.username, "scripts-mac-mini", ana, macMini05);
    return ana.username;
  }

  it("draws its design and its office implementation converted to 0.6, as the native awml draws the converted file", async () => {
    const o = await stored05();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "client-email" })).html)).toBe(
      example("older/client-email-05.mmd").trimEnd(),
    );
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "client-email" })).html)).toBe(
      example("older/client-email-05-office.mmd").trimEnd(),
    );
  });

  it("keeps its checks as stored, named by the AWML that made them", async () => {
    const o = await stored05();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "client-email" })).html;
    const { checks } = stored("client-email-05");
    expect(checks.awml.tag).toBe("v0.5.1");
    expect(checkIds(page)).toEqual(checks.checks.map((c: { id: string }) => c.id));
    expect(text(page)).toContain("workflow.yaml Checked by AWML v0.5.1 ");
  });

  it("shows its stored bytes on the YAML tab, saying it is AWML 0.5 shown converted to 0.6", async () => {
    const o = await stored05();
    const page = (await renderPage(WorkflowYamlPage, { owner: o, slug: "client-email" })).html;
    expect(files(page)).toEqual({ "workflow-yaml": clientEmail05 });
    expect(text(page)).toContain(
      "workflow.yaml is AWML 0.5, as it was pushed. The registry draws, checks and fits it converted to AWML 0.6.",
    );
  });

  it("fits its design and its office implementation against the stored description, both through convert, as the native fit does", async () => {
    const o = await stored05();
    const strip = ({ platform: _, ...rest }: { platform: string }) => rest;
    const design = await fit({ workflow: `${o}/client-email`, platforms: [`${o}/scripts-mac-mini`] });
    expect(design.status).toBe(200);
    expect(design.body.results).toEqual(
      JSON.parse(example("older/client-email-05.fit.json")).results.map((r: { platform: string }) => ({
        platform: `${o}/scripts-mac-mini`,
        number: 1,
        id: "scripts-mac-mini",
        label: "Scheduled scripts on a Mac mini",
        ...strip(r),
      })),
    );
    const office = await fit({ workflow: `${o}/client-email`, implementation: "office" });
    expect(office.status).toBe(200);
    expect(office.body.results).toEqual(
      JSON.parse(example("older/client-email-05-office.fit.json")).results.map((r: { platform: string }) =>
        r.platform === "cowork"
          ? { block: "cowork", platform: `${o}/scripts-mac-mini`, number: 1, id: "scripts-mac-mini", label: "Scheduled scripts on a Mac mini", ...strip(r) }
          : { block: r.platform, platform: null, number: null, id: null, label: null, ...strip(r) },
      ),
    );
    // A 0.6 workflow sent as a file fits against the stored 0.5 description too.
    const sent = await fit({ file: dinners, platforms: [`${o}/scripts-mac-mini`] });
    expect(sent.status).toBe(200);
    expect(await storedBytes()).toEqual({ workflows: [clientEmail05], descriptions: [macMini05] });
  });

  it("shows the description's stored bytes on its YAML tab, saying it is AWML 0.5 read converted to 0.6, and what it offers", async () => {
    const o = await stored05();
    const yaml = (await renderPage(PlatformYamlPage, { owner: o, slug: "scripts-mac-mini" })).html;
    expect(files(yaml)).toEqual({ "description-yaml": macMini05 });
    expect(text(yaml)).toContain("description.yaml is AWML 0.5, as it was pushed. The fit reads it converted to AWML 0.6.");
    expect(await (await request("GET", `/${o}/platforms/scripts-mac-mini/v/1/description.yaml`)).text()).toBe(macMini05);
    expect((await (await request("GET", `/api/v1/platforms/${o}/scripts-mac-mini`)).json()).description).toBe(macMini05);
    expect(text((await renderPage(PlatformPage, { owner: o, slug: "scripts-mac-mini" })).html)).toContain("Can call anthropic");
  });
});
