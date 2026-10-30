// From AWML 0.10 the registry takes only 0.10 files, workflows and platform
// descriptions both, and refuses an older push with a 400 naming
// `awml convert`, as it refused older ones from 0.6, 0.7, 0.8 and 0.9. Versions stored in an
// older AWML are never rewritten: each is converted with the engine's
// `convert` whenever it is read, so it still shows, checks, draws and fits,
// while its YAML and raw file are the bytes that were pushed. Checks stored at
// push stay as stored. What converting a file notes for its author to do by
// hand is shown, and fails nothing: `awml convert` exits 1 for it, and still
// writes the whole file, which is what is read. A file that converts to a
// drawing with errors is drawn, its errors red; one that converts to an
// invalid file is not drawn (#100).
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { platformVersion, version } from "@/db/schema";
import { engine } from "@/engine";
import { PLATFORM_IS_TOO_OLD, WORKFLOW_IS_TOO_OLD } from "@/server/awml-file";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import WorkflowEmbed from "@/app/[owner]/[slug]/embed/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import VersionEmbed from "@/app/[owner]/[slug]/v/[n]/embed/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import GalleryPage from "@/app/gallery/page";
import PlatformPage from "@/app/[owner]/platforms/[slug]/page";
import PlatformYamlPage from "@/app/[owner]/platforms/[slug]/yaml/page";
import { drawing, expectedOf } from "./drawn";
import { example, person, request, storePlatformVersion, storeVersion, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage, sealed } from "./pages";

// As they were pushed: a 0.4 workflow, a 0.5 one, and a 0.5 platform
// description that the 0.5 workflow's office implementation names; a 0.6
// workflow whose do step leads into another workflow's trigger, which AWML 0.7
// makes an outside action that starts that workflow; two 0.7 workflows: the
// family's dinners, and the bakery's enquiries, whose untrusted text reaches
// an outside action with nothing to stop it, which 0.7 warned of, 0.8 found a
// mistake and 0.9 finds an error; two 0.8 workflows: the family's dinners
// again, and a newsletter whose outside action writes to a context, which 0.9
// finds invalid; and a 0.9 workflow, the club's minutes, whose review writes to
// a context, which 0.10 finds invalid.
const dinners04 = example("older/dinners-04.yaml");
const clientEmail05 = example("older/client-email-05.yaml");
const macMini05 = example("older/scripts-mac-mini-05.yaml");
const stock06 = example("older/bakery-stock-06.yaml");
const dinners07 = example("older/dinners-07.yaml");
const enquiries07 = example("older/enquiries-07.yaml");
const dinners08 = example("older/dinners-08.yaml");
const signOff08 = example("older/sign-off-08.yaml");
const minutes09 = example("older/minutes-09.yaml");
// What the native `awml convert` noted converting it, after its first line.
const stock06Notes = example("older/bakery-stock-06.convert.txt").trim().split("\n").slice(1).map((l) => l.trim());
// What the AWML of the day worked out for each workflow at push: 0.5.1 for the 0.5 one, the
// registry's 0.7.1 engine for the 0.7 ones, its 0.8.0 engine for the 0.8 ones and its 0.9.0
// engine for the 0.9 one.
const stored = (name: string) => ({
  summary: JSON.parse(example(`older/${name}.summary.json`)),
  checks: JSON.parse(example(`older/${name}.checks.json`)),
});
const dinners = example("dinners.yaml"); // 0.10
const worker = example("platforms/worker.yaml"); // 0.10
const signOff = example("sign-off.yaml"); // 0.10, invalid

const unescape = (html: string) =>
  html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
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
  it("takes a 0.10 workflow and a 0.10 platform description", async () => {
    const ana = await person("ana");
    expect(dinners).toMatch(/^awml: "0\.10"$/m);
    expect(await push(ana.username, "dinners", { token: ana.token }, { workflow: dinners })).toMatchObject({ status: 201 });
    const published = await call("publish", { owner: ana.username, slug: "dinners", workflow: dinners }, ana.token);
    expect(published).toMatchObject({ isError: false, data: { number: 2 } });
    expect(worker).toMatch(/^awml: "0\.10"$/m);
    const res = await request("POST", `/api/v1/platforms/${ana.username}/worker/versions`, {
      as: { token: ana.token },
      json: { description: worker },
    });
    expect(res.status).toBe(201);
  });

  it("refuses a 0.4, 0.5, 0.6, 0.7, 0.8 or 0.9 workflow with a 400 naming awml convert, through the API, MCP and the fit", async () => {
    const ana = await person("ana");
    expect(WORKFLOW_IS_TOO_OLD).toBe(
      "This registry takes AWML 0.10 files. Upgrade yours with `awml convert workflow.yaml > upgraded.yaml`, " +
        "or join a 0.3 pair with `awml convert security.yaml platform.yaml > upgraded.yaml`, and push that.",
    );
    // A 0.7, 0.8 or 0.9 file that 0.10 reads by its version alone is refused all the same.
    expect(dinners07.replace('awml: "0.7"', 'awml: "0.10"')).toBe(dinners);
    expect(dinners08.replace('awml: "0.8"', 'awml: "0.10"')).toBe(dinners);
    for (const file of [
      dinners04,
      clientEmail05,
      stock06,
      dinners.replace('awml: "0.10"', 'awml: "0.6"'),
      dinners07,
      enquiries07,
      dinners08,
      signOff08,
      dinners.replace('awml: "0.10"', 'awml: "0.9"'),
      minutes09,
    ]) {
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

  it("refuses a 0.4, 0.5, 0.6, 0.7, 0.8 or 0.9 platform description with a 400 naming awml convert, through the API and MCP", async () => {
    const ana = await person("ana");
    expect(PLATFORM_IS_TOO_OLD).toBe(
      "This registry takes AWML 0.10 platform descriptions. Upgrade yours with `awml convert description.yaml > upgraded.yaml` and push that.",
    );
    for (const description of [
      macMini05,
      macMini05.replace('awml: "0.5"', 'awml: "0.4"'),
      worker.replace('awml: "0.10"', 'awml: "0.6"'),
      worker.replace('awml: "0.10"', 'awml: "0.7"'),
      worker.replace('awml: "0.10"', 'awml: "0.8"'),
      worker.replace('awml: "0.10"', 'awml: "0.9"'),
    ]) {
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

  // YAML reads an unquoted 0.10 as the number 0.1, so the registry reads the version as it is
  // written: such a file is 0.10, and awml check says to quote it, as for an unquoted 0.9 before.
  it("leaves a workflow or platform description marked with an unquoted 0.10 to awml check, which says to quote it", async () => {
    const ana = await person("ana");
    const workflow = dinners.replace('awml: "0.10"', "awml: 0.10");
    const mistakes = await engine.check(workflow);
    expect(mistakes).toContain("awml: YAML read it as 0.1, not text: put it in quotes");
    expect(await push(ana.username, "dinners", { token: ana.token }, { workflow })).toEqual({
      status: 422,
      body: { errors: mistakes.map((m) => `workflow: ${m}`) },
    });
    const description = worker.replace('awml: "0.10"', "awml: 0.10");
    const res = await request("POST", `/api/v1/platforms/${ana.username}/worker/versions`, {
      as: { token: ana.token },
      json: { description },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toContain("description: awml: YAML read it as 0.1, not text: put it in quotes");
  });
});

describe("a stored 0.4 version, with no checks stored", () => {
  async function stored04() {
    const ana = await person("ana");
    await storeVersion(ana.username, "dinners", ana, { workflow: dinners04 }, { summary: stored("dinners-04").summary });
    return ana.username;
  }

  it("draws its design and its implementation converted to 0.10, as the native awml draws the converted file", async () => {
    const o = await stored04();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners04]));
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners04], "home"));
  });

  it("has its checks worked out when shown, through convert, by the AWML the registry runs", async () => {
    const o = await stored04();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" })).html;
    expect(checkIds(page)).toEqual(listedNow("dinners-04"));
    expect(text(page)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
    expect(text(page)).toContain("Checks No mistakes");
    expect((await storedBytes()).workflows).toEqual([dinners04]);
  });

  it("shows its stored bytes on the YAML tab, saying it is AWML 0.4 shown converted to 0.10, and serves them as the raw file", async () => {
    const o = await stored04();
    for (const page of [
      await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" }),
      await renderPage(VersionYamlPage, { owner: o, slug: "dinners", n: "1" }),
    ]) {
      expect(files(page.html)).toEqual({ "workflow-yaml": dinners04 });
      expect(text(page.html)).toContain(
        "workflow.yaml is AWML 0.4, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10.",
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
    expect(drawing((await renderPage(GalleryPage, {})).html)).toEqual(await expectedOf([dinners04]));
  });

  it("is forked as the converted 0.10 file, since a fork is a push, its top comment now its description", async () => {
    const o = await stored04();
    const bea = await person("bea");
    const res = await request("POST", `/api/v1/${o}/dinners/fork`, { as: { token: bea.token }, json: { owner: bea.username } });
    expect(res.status).toBe(201);
    const fork = (await (await request("GET", `/api/v1/${bea.username}/dinners/v/1`)).json()).files.workflow;
    expect(fork).toMatch(/^awml: "0\.10"$/m);
    expect(fork).not.toContain("kind: publish");
    // AWML 0.9's convert makes the comment an older file starts with its description.
    expect(dinners04).toMatch(/^# This workflow plans a family's dinners/);
    expect(fork).toMatch(/^description: \|\n {2}This workflow plans a family's dinners, fills its shopping basket/m);
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

  it("draws its design and its office implementation converted to 0.10, as the native awml draws the converted file", async () => {
    const o = await stored05();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "client-email" })).html)).toEqual(await expectedOf([clientEmail05]));
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "client-email" })).html)).toEqual(await expectedOf([clientEmail05], "office"));
  });

  it("keeps its checks as stored, named by the AWML that made them", async () => {
    const o = await stored05();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "client-email" })).html;
    const { checks } = stored("client-email-05");
    expect(checks.awml.tag).toBe("v0.5.1");
    expect(checkIds(page)).toEqual(checks.checks.map((c: { id: string }) => c.id));
    expect(text(page)).toContain("workflow.yaml Checked by AWML v0.5.1 ");
  });

  it("shows its stored bytes on the YAML tab, saying it is AWML 0.5 shown converted to 0.10", async () => {
    const o = await stored05();
    const page = (await renderPage(WorkflowYamlPage, { owner: o, slug: "client-email" })).html;
    expect(files(page)).toEqual({ "workflow-yaml": clientEmail05 });
    expect(text(page)).toContain(
      "workflow.yaml is AWML 0.5, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10.",
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
    // A 0.8 workflow sent as a file fits against the stored 0.5 description too.
    const sent = await fit({ file: dinners, platforms: [`${o}/scripts-mac-mini`] });
    expect(sent.status).toBe(200);
    expect(await storedBytes()).toEqual({ workflows: [clientEmail05], descriptions: [macMini05] });
  });

  it("shows the description's stored bytes on its YAML tab, saying it is AWML 0.5 read converted to 0.10, and what it offers", async () => {
    const o = await stored05();
    const yaml = (await renderPage(PlatformYamlPage, { owner: o, slug: "scripts-mac-mini" })).html;
    expect(files(yaml)).toEqual({ "description-yaml": macMini05 });
    expect(text(yaml)).toContain("description.yaml is AWML 0.5, as it was pushed. The fit reads it converted to AWML 0.10.");
    expect(await (await request("GET", `/${o}/platforms/scripts-mac-mini/v/1/description.yaml`)).text()).toBe(macMini05);
    expect((await (await request("GET", `/api/v1/platforms/${o}/scripts-mac-mini`)).json()).description).toBe(macMini05);
    expect(text((await renderPage(PlatformPage, { owner: o, slug: "scripts-mac-mini" })).html)).toContain("Can call anthropic");
  });
});

describe("a stored 0.6 version whose do step leads into another workflow's trigger", () => {
  // AWML 0.7 starts another workflow with an outside action, so converting it
  // makes that trigger the outside action, keeping its ref, and notes that its
  // untrusted mark belongs on the trigger it starts.
  async function stored06() {
    const ana = await person("ana");
    await storeVersion(ana.username, "bakery-stock", ana, { workflow: stock06 });
    return ana.username;
  }

  it("converts as the native awml convert does: the whole file, and what it noted apart from its mistakes", async () => {
    expect(await engine.check(stock06)).toEqual(['awml is "0.6", which this release no longer reads: upgrade the file with awml convert']);
    const converted = await engine.convert([stock06]);
    if ("error" in converted) throw new Error(converted.error);
    expect(converted.notes).toEqual(stock06Notes);
    expect(converted.mistakes).toEqual([]);
    expect(converted.file).toMatch(/^awml: "0\.10"$/m);
    expect(converted.file).toContain('{ id: order, kind: outside, label: "Start the supplier order: Allow", ref: acme/order#low, in: bakery }');
    expect(JSON.parse(await engine.graph(converted.file))).toEqual(JSON.parse(example("older/bakery-stock-06.graph.json")));
  });

  it("draws it converted to 0.10, the trigger now the outside action that starts the other workflow", async () => {
    const o = await stored06();
    const drawn = drawing((await renderPage(WorkflowPage, { owner: o, slug: "bakery-stock" })).html);
    expect(drawn).toEqual(await expectedOf([stock06]));
    expect(drawn?.parts.order).toBe("Start the supplier order: Allow");
  });

  it("shows what converting it noted on its Checks and YAML tabs, which fails nothing", async () => {
    const o = await stored06();
    const checks = (await renderPage(WorkflowChecksPage, { owner: o, slug: "bakery-stock" })).html;
    expect(checkIds(checks)).toEqual(listedNow("bakery-stock-06"));
    expect(text(checks)).toContain(
      `workflow.yaml Checked by AWML ${engine.version.tag} Converting it to AWML 0.10, awml convert noted what to do by hand. Notes don't fail the check. ${stock06Notes.join(" ")} `,
    );
    expect(text(checks)).toContain("Checks No mistakes");
    const yaml = (await renderPage(WorkflowYamlPage, { owner: o, slug: "bakery-stock" })).html;
    expect(files(yaml)).toEqual({ "workflow-yaml": stock06 });
    expect(text(yaml)).toContain(
      "workflow.yaml is AWML 0.6, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10. " +
        `Converting it to AWML 0.10, awml convert noted what to do by hand. Notes don't fail the check. ${stock06Notes.join(" ")}`,
    );
    expect(await (await request("GET", `/${o}/bakery-stock/v/1/workflow.yaml`)).text()).toBe(stock06);
    expect((await storedBytes()).workflows).toEqual([stock06]);
  });
});

describe("a stored 0.7 version, with the checks stored at push", () => {
  // AWML 0.10 reads a 0.7 file once its version says 0.10, unless it has a fork, which 0.8
  // dropped; the dinners have none.
  async function stored07() {
    const ana = await person("ana");
    await storeVersion(ana.username, "dinners", ana, { workflow: dinners07 }, stored("dinners-07"));
    return ana.username;
  }

  it("converts by its version alone, as the native awml convert does", async () => {
    expect(await engine.check(dinners07)).toEqual(['awml is "0.7", which this release no longer reads: upgrade the file with awml convert']);
    expect(await engine.convert([dinners07])).toEqual({ file: dinners, notes: [], mistakes: [] });
  });

  it("draws its design and its implementation converted to 0.10, as the native awml draws the converted file", async () => {
    const o = await stored07();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners07]));
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners07], "home"));
    expect(JSON.parse(await engine.graph(dinners))).toEqual(JSON.parse(example("older/dinners-07.graph.json")));
    expect(drawing((await renderPage(GalleryPage, {})).html)).toEqual(await expectedOf([dinners07]));
  });

  it("keeps its checks as stored, named by the AWML 0.7.1 that made them, and its YAML as pushed", async () => {
    const o = await stored07();
    const checks = (await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" })).html;
    expect(stored("dinners-07").checks.awml.tag).toBe("v0.7.1");
    expect(checkIds(checks)).toEqual(stored("dinners-07").checks.checks.map((c: { id: string }) => c.id));
    expect(text(checks)).toContain("workflow.yaml Checked by AWML v0.7.1 ");
    expect(text(checks)).toContain("Checks No mistakes");
    const yaml = (await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" })).html;
    expect(files(yaml)).toEqual({ "workflow-yaml": dinners07 });
    expect(text(yaml)).toContain("workflow.yaml is AWML 0.7, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10.");
    expect((await storedBytes()).workflows).toEqual([dinners07]);
  });

  it("fits against a stored 0.7 platform description through convert, as the native fit judges its 0.10 form", async () => {
    const ana = await person("ana");
    const worker07 = worker.replace('awml: "0.10"', 'awml: "0.7"');
    await storePlatformVersion(ana.username, "worker", ana, worker07);
    const res = await fit({ file: example("client-email.yaml"), platforms: [`${ana.username}/worker`] });
    expect(res.status).toBe(200);
    const native = (JSON.parse(example("client-email.fit.json")).results as { platform: string }[]).find((r) => r.platform === "worker")!;
    const { platform: _, ...judged } = native;
    expect(res.body.results).toEqual([{ platform: `${ana.username}/worker`, number: 1, id: "worker", label: "A code worker", ...judged }]);
    expect((await storedBytes()).descriptions).toEqual([worker07]);
  });
});

// AWML 0.7 warned when untrusted text reached an outside action with nothing to stop it; 0.8
// found it a mistake, `untrusted.outside` (chrismdp/awml#151), and 0.9 finds it an error, a line
// that breaks a rule in a valid drawing (#100, awml#197). So a 0.7 version stored with that
// warning, which passed then, now has an error in its checks, beside a warning mark, and is
// drawn, as `awml draw` draws it, its error a line the drawing draws red (#83).
describe("a stored 0.7 version whose untrusted text reaches an outside action that nothing stops", () => {
  const message =
    'untrusted text from part "form" reaches outside action "label" with nothing to stop it or accept the risk: ' +
    "a review, a person's own step or a code step marked cleans on the way would stop it, or a standing approval in front of the action would accept the risk";

  async function storedEnquiries() {
    const ana = await person("ana");
    await storeVersion(ana.username, "enquiries", ana, { workflow: enquiries07 }, stored("enquiries-07"));
    return ana.username;
  }

  it("passed with a warning when it was pushed, and has an error now, as the native awml checks it converted", async () => {
    const atPush = stored("enquiries-07").checks.checks.filter((c: { result: string }) => c.result !== "pass" && c.result !== "skipped");
    expect(atPush.map((c: { id: string; result: string }) => [c.id, c.result])).toEqual([["warn.untrusted-outside", "warn"]]);
    const converted = await engine.convert([enquiries07]);
    if ("error" in converted) throw new Error(converted.error);
    expect(converted.mistakes).toEqual([]);
    expect(await engine.check(converted.file)).toEqual([message]);
    expect(await engine.errors(converted.file)).toEqual([message]);
    expect(await engine.unsound(converted.file)).toEqual([]);
    const now = JSON.parse(example("older/enquiries-07.checks-now.json")).checks;
    expect(now.filter((c: { result: string }) => c.result === "error").map((c: { id: string }) => c.id)).toEqual(["untrusted.outside"]);
    // Untrusted text nobody accepted is an error, so a push of the file in 0.10 is taken, and says so.
    const bea = await person("bea");
    expect(await push(bea.username, "enquiries", { token: bea.token }, { workflow: converted.file })).toMatchObject({
      status: 201,
      body: { errors: [{ check: "untrusted.outside", message }] },
    });
  });

  it("lists its checks now, by the AWML the registry runs, with untrusted.outside an error beside a warning mark", async () => {
    const o = await storedEnquiries();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "enquiries" })).html;
    expect(checkIds(page)).toEqual(listedNow("enquiries-07"));
    expect(text(page)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
    expect(text(page)).toContain("Checks 1 error");
    expect(text(page)).toContain(`No untrusted text reaches an outside action unstopped untrusted.outside 1 error`);
    expect(text(page)).toContain(message);
    expect(page).toContain('<svg class="warning-mark"');
    expect(text(page)).not.toContain("mistake");
  });

  it("is drawn, the way to the outside action red from the part the text comes from, and says it has an error", async () => {
    const o = await storedEnquiries();
    const { html } = await renderPage(WorkflowPage, { owner: o, slug: "enquiries" });
    expect(drawing(html)).toEqual(await expectedOf([enquiries07]));
    expect(html).toContain('<g class="flow-part flow-kind-trigger unstopped">');
    expect(html.match(/<path class="flow-line [^"]*\bunstopped\b/g)).toHaveLength(3);
    expect(html.match(/<path class="flow-line [^"]*\bcarries\b/g)).toHaveLength(3);
    expect(html.match(/<path class="flow-line [^"]*\bstopped\b/g)).toHaveLength(1);
    expect(text(html)).toContain("workflow.yaml has 1 error, drawn in red. See Checks.");
    expect(text(html)).toContain("Checks 1 error");
    expect(html).not.toContain("so it cannot be drawn");
  });

  it("is drawn the same on its gallery card and in an embed", async () => {
    const o = await storedEnquiries();
    for (const html of [(await renderPage(GalleryPage, {})).html, (await renderPage(WorkflowEmbed, { owner: o, slug: "enquiries" })).html]) {
      expect(drawing(html)).toEqual(await expectedOf([enquiries07]));
      expect(html).toContain('<g class="flow-part flow-kind-trigger unstopped">');
      expect(html.match(/<path class="flow-line [^"]*\bunstopped\b/g)).toHaveLength(3);
    }
  });
});

describe("a stored 0.8 version, with the checks stored at push", () => {
  // AWML 0.9 changed only a rule, so a 0.8 file converts by changing only its version, where it
  // starts with no comment to make its description.
  async function stored08() {
    const ana = await person("ana");
    await storeVersion(ana.username, "dinners", ana, { workflow: dinners08 }, stored("dinners-08"));
    return ana.username;
  }

  it("converts by its version alone, as the native awml convert does", async () => {
    expect(await engine.check(dinners08)).toEqual(['awml is "0.8", which this release no longer reads: upgrade the file with awml convert']);
    expect(await engine.convert([dinners08])).toEqual({ file: dinners, notes: [], mistakes: [] });
  });

  it("draws its design and its implementation converted to 0.10, as the native awml draws the converted file", async () => {
    const o = await stored08();
    expect(drawing((await renderPage(WorkflowPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners08]));
    expect(drawing((await renderPage(WorkflowPlatformPage, { owner: o, slug: "dinners" })).html)).toEqual(await expectedOf([dinners08], "home"));
    expect(JSON.parse(await engine.graph(dinners))).toEqual(JSON.parse(example("older/dinners-08.graph.json")));
    expect(drawing((await renderPage(GalleryPage, {})).html)).toEqual(await expectedOf([dinners08]));
  });

  it("keeps its checks as stored, named by the AWML 0.8.0 that made them, and its YAML as pushed", async () => {
    const o = await stored08();
    const checks = (await renderPage(WorkflowChecksPage, { owner: o, slug: "dinners" })).html;
    expect(stored("dinners-08").checks.awml.tag).toBe("v0.8.0");
    expect(checkIds(checks)).toEqual(stored("dinners-08").checks.checks.map((c: { id: string }) => c.id));
    expect(text(checks)).toContain("workflow.yaml Checked by AWML v0.8.0 ");
    expect(text(checks)).toContain("Checks No mistakes");
    const yaml = (await renderPage(WorkflowYamlPage, { owner: o, slug: "dinners" })).html;
    expect(files(yaml)).toEqual({ "workflow-yaml": dinners08 });
    expect(text(yaml)).toContain("workflow.yaml is AWML 0.8, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10.");
    expect((await storedBytes()).workflows).toEqual([dinners08]);
  });

  it("fits through convert, as the native fit judges its 0.10 form, against a stored 0.8 platform description", async () => {
    const ana = await person("ana");
    await storeVersion(ana.username, "client-email", ana, { workflow: example("client-email.yaml").replace('awml: "0.10"', 'awml: "0.8"') });
    const worker08 = worker.replace('awml: "0.10"', 'awml: "0.8"');
    await storePlatformVersion(ana.username, "worker", ana, worker08);
    const res = await fit({ workflow: `${ana.username}/client-email`, platforms: [`${ana.username}/worker`] });
    expect(res.status).toBe(200);
    const native = (JSON.parse(example("client-email.fit.json")).results as { platform: string }[]).find((r) => r.platform === "worker")!;
    const { platform: _, ...judged } = native;
    expect(res.body.results).toEqual([{ platform: `${ana.username}/worker`, number: 1, id: "worker", label: "A code worker", ...judged }]);
    expect((await storedBytes()).descriptions).toEqual([worker08]);
  });
});

// AWML 0.8 let a line go from an outside action into a context; AWML 0.9 finds the file invalid,
// under `contexts.written-by-steps` (awml#149). So a 0.8 version stored with such a line, which
// passed then, converts to an invalid file: its checks are listed now, with that check failing,
// and it is not drawn, nor forked, since a fork is a push.
describe("a stored 0.8 version that 0.9 finds invalid", () => {
  const [mistake] = example("sign-off.check.txt")
    .trim()
    .split("\n")
    .map((l) => l.replace(/^sign-off\.yaml: /, ""));

  async function storedSignOff() {
    const ana = await person("ana");
    await storeVersion(ana.username, "newsletter", ana, { workflow: signOff08 }, stored("sign-off-08"));
    return ana.username;
  }

  it("passed when it was pushed, and converts by its version alone to a file the native awml finds invalid", async () => {
    const atPush = stored("sign-off-08").checks.checks.filter((c: { result: string }) => c.result !== "pass" && c.result !== "skipped");
    expect(atPush).toEqual([]);
    expect(await engine.convert([signOff08])).toEqual({ file: signOff, notes: [], mistakes: [mistake] });
    expect(await engine.unsound(signOff)).toEqual([mistake]);
    const now = JSON.parse(example("older/sign-off-08.checks-now.json")).checks;
    expect(now.filter((c: { result: string }) => c.result === "fail").map((c: { id: string }) => c.id)).toEqual(["contexts.written-by-steps"]);
  });

  it("lists its checks now, by the AWML the registry runs, with contexts.written-by-steps failing", async () => {
    const o = await storedSignOff();
    const page = (await renderPage(WorkflowChecksPage, { owner: o, slug: "newsletter" })).html;
    expect(checkIds(page)).toEqual(listedNow("sign-off-08"));
    expect(text(page)).toContain(`It is checked again here, by the AWML this registry runs.`);
    expect(text(page)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
    expect(text(page)).toContain("Checks 1 mistake");
    expect(text(page)).toContain(`Only a step writes to a context contexts.written-by-steps 1 mistake`);
    expect(text(page)).toContain(mistake);
    expect(page).not.toContain('<svg class="warning-mark"');
  });

  it("is not drawn, on its page, its gallery card or an embed, and says why", async () => {
    const o = await storedSignOff();
    const { html } = await renderPage(WorkflowPage, { owner: o, slug: "newsletter" });
    expect(drawing(html)).toBeNull();
    expect(text(html)).toContain("workflow.yaml has 1 mistake, so it cannot be drawn. See Checks.");
    expect(drawing((await renderPage(GalleryPage, {})).html)).toBeNull();
    expect(drawing((await renderPage(WorkflowEmbed, { owner: o, slug: "newsletter" })).html)).toBeNull();
    expect(await fit({ workflow: `${o}/newsletter` })).toEqual({ status: 422, body: { errors: [`${o}/newsletter v1: ${mistake}`] } });
  });

  it("can't be forked, since a fork is a push and a push refuses an invalid file", async () => {
    const o = await storedSignOff();
    const bea = await person("bea");
    const res = await request("POST", `/api/v1/${o}/newsletter/fork`, { as: { token: bea.token }, json: { owner: bea.username } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ errors: [`workflow: ${mistake}`] });
    expect((await storedBytes()).workflows).toEqual([signOff08]);
  });
});

// AWML 0.9 let a line go into a context from a review; AWML 0.10 lets only a step write to a
// context, under the same `contexts.written-by-steps` (awml#191). So a 0.9 version stored with such
// a line, which passed then, converts by its version alone to an invalid file. It is not drawn, and
// wherever its drawing would be, on its page and in an embed, the check's message says what to
// redraw, as its Checks tab does.
describe("a stored 0.9 version that 0.10 finds invalid", () => {
  const minutes = minutes09.replace('awml: "0.9"', 'awml: "0.10"');
  const [mistake] = (
    JSON.parse(example("older/minutes-09.checks-now.json")) as { checks: { mistakes: { message: string }[] }[] }
  ).checks.flatMap((c) => c.mistakes.map((m) => m.message));

  async function storedMinutes() {
    const ana = await person("ana");
    await storeVersion(ana.username, "minutes", ana, { workflow: minutes09 }, stored("minutes-09"));
    return ana.username;
  }

  it("passed when it was pushed, and converts by its version alone to a file the native awml finds invalid", async () => {
    expect(stored("minutes-09").checks.awml.tag).toBe("v0.9.0");
    const atPush = stored("minutes-09").checks.checks.filter((c: { result: string }) => c.result !== "pass" && c.result !== "skipped");
    expect(atPush).toEqual([]);
    expect(mistake).toMatch(/^the line from "approve" to "book" goes from review "approve" into context "book": only a step writes to a context, /);
    expect(await engine.convert([minutes09])).toEqual({ file: minutes, notes: [], mistakes: [mistake] });
    expect(await engine.unsound(minutes)).toEqual([mistake]);
    const now = JSON.parse(example("older/minutes-09.checks-now.json")).checks;
    expect(now.filter((c: { result: string }) => c.result === "fail").map((c: { id: string }) => c.id)).toEqual(["contexts.written-by-steps"]);
  });

  it("lists its checks now, by the AWML the registry runs, with contexts.written-by-steps failing and its message", async () => {
    const o = await storedMinutes();
    for (const page of [
      await renderPage(WorkflowChecksPage, { owner: o, slug: "minutes" }),
      await renderPage(VersionChecksPage, { owner: o, slug: "minutes", n: "1" }),
    ]) {
      expect(page.status).toBe(200);
      expect(checkIds(page.html)).toEqual(listedNow("minutes-09"));
      expect(text(page.html)).toContain(`workflow.yaml Checked by AWML ${engine.version.tag} `);
      expect(text(page.html)).toContain("Checks 1 mistake");
      expect(text(page.html)).toContain("Only a step writes to a context contexts.written-by-steps 1 mistake");
      expect(text(page.html)).toContain(mistake);
    }
  });

  it("is not drawn, and its page and its embeds give the check's message where the drawing would be", async () => {
    const o = await storedMinutes();
    for (const page of [
      await renderPage(WorkflowPage, { owner: o, slug: "minutes" }),
      await renderPage(VersionPage, { owner: o, slug: "minutes", n: "1" }),
    ]) {
      expect(page.status).toBe(200);
      expect(drawing(page.html)).toBeNull();
      expect(text(page.html)).toContain(`workflow.yaml has 1 mistake, so it cannot be drawn. See Checks. ${mistake}`);
    }
    for (const page of [
      await renderPage(WorkflowEmbed, { owner: o, slug: "minutes" }, { headers: sealed }),
      await renderPage(VersionEmbed, { owner: o, slug: "minutes", n: "1" }, { headers: sealed }),
    ]) {
      expect(page.status).toBe(200);
      expect(drawing(page.html)).toBeNull();
      expect(text(page.html)).toContain(`workflow.yaml has 1 mistake, so it cannot be drawn. ${mistake}`);
    }
    expect(drawing((await renderPage(GalleryPage, {})).html)).toBeNull();
    expect(await fit({ workflow: `${o}/minutes` })).toEqual({ status: 422, body: { errors: [`${o}/minutes v1: ${mistake}`] } });
  });

  it("shows its stored bytes on the YAML tab, saying it is AWML 0.9 read converted to 0.10", async () => {
    const o = await storedMinutes();
    const yaml = (await renderPage(WorkflowYamlPage, { owner: o, slug: "minutes" })).html;
    expect(files(yaml)).toEqual({ "workflow-yaml": minutes09 });
    expect(text(yaml)).toContain("workflow.yaml is AWML 0.9, as it was pushed. The registry draws, checks and fits it converted to AWML 0.10.");
    expect((await storedBytes()).workflows).toEqual([minutes09]);
  });
});
