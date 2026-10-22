// The platform pages: an owner's platforms at /{owner}/platforms, with help
// for adding one, and the shared platforms at /platforms. Private platforms
// follow the private workflow rules: members see them listed, nobody else.
import { describe, expect, it } from "vitest";
import OwnerPage from "@/app/[owner]/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import OwnerPlatformsPage from "@/app/[owner]/platforms/page";
import SharedPlatformsPage from "@/app/platforms/page";
import PlatformPage from "@/app/platforms/[owner]/[slug]/page";
import PlatformRecipePage from "@/app/platforms/[owner]/[slug]/recipe/page";
import PlatformYamlPage from "@/app/platforms/[owner]/[slug]/yaml/page";
import PlatformVersionPage from "@/app/platforms/[owner]/[slug]/v/[n]/page";
import PlatformVersionRecipePage from "@/app/platforms/[owner]/[slug]/v/[n]/recipe/page";
import PlatformVersionYamlPage from "@/app/platforms/[owner]/[slug]/v/[n]/yaml/page";
import { example, orgWith, person, request, type Who } from "./helpers";
import { call } from "./mcp-client";
import { renderPage, type Page } from "./pages";

const backOffice = `awml: "0.3"
platform: { id: back-office, label: "Acme's back office" }
off_for_up_to: PT0S
steps: code
agents: []
calls: [anthropic]
holds: [notes]
`;
const betaVault = backOffice.replace("back-office", "beta-vault").replace("Acme's back office", "Beta's vault server");
const recipe = "# Install on the back office\n\n1. Copy the workflow's code to /srv/workflows.\n";
const worker = example("platforms/worker.yaml");
const laptop = example("platforms/codex-laptop.yaml");

// The page's text, with tags as spaces, except the ends of links and code,
// so the punctuation after them stays put, and runs of spaces as one.
const text = (html: string) =>
  html
    .replace(/<\/?code>|<\/a>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function pushPlatform(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, { as, json: body });
  expect(res.status, await res.clone().text()).toBe(201);
}

// Acme, with Olive as owner and Mo as member, keeps a private back office
// with a recipe and a public worker at version 2 without one. Beta, Bea's,
// keeps a private vault and a public open box. Nell belongs to nothing.
async function platforms() {
  const olive = await person("olive");
  const mo = await person("mo");
  const nell = await person("nell");
  const bea = await person("bea");
  await orgWith("acme", olive, [mo]);
  await orgWith("beta", bea);
  await pushPlatform("acme", "back-office", { token: olive.token }, { description: backOffice, recipe, visibility: "private" });
  await pushPlatform("acme", "worker", { token: olive.token }, { description: worker });
  await pushPlatform("acme", "worker", { token: mo.token }, { description: worker });
  await pushPlatform("beta", "vault", { token: bea.token }, { description: betaVault, recipe, visibility: "private" });
  await pushPlatform("beta", "open-box", { token: bea.token }, { description: worker });
  return { olive, mo, nell, bea };
}

const page = (owner: string, as?: Who) => renderPage(OwnerPlatformsPage, { owner }, { as });
const shared = (as?: Who, q?: string) => renderPage(SharedPlatformsPage, {}, { as, search: q === undefined ? {} : { q } });

describe("an owner's platforms page", () => {
  it("lists each platform with its label, version and links to its description and recipe files", async () => {
    const { mo } = await platforms();
    const shown = await page("acme", { cookie: mo.cookie });
    expect(shown.status).toBe(200);
    const words = text(shown.html);
    expect(words).toContain("acme's platforms");
    expect(words).toContain("Acme's back office acme/back-office Private · Version 1 Description Install recipe");
    expect(words).toContain("A code worker acme/worker Public · Version 2 Description No install recipe");
    expect(shown.html).toMatch(/<a href="\/platforms\/acme\/back-office">Acme&#x27;s back office<\/a>/);
    expect(shown.html).toMatch(/<a href="\/platforms\/acme\/back-office">Description<\/a>/);
    expect(shown.html).toMatch(/<a href="\/platforms\/acme\/back-office\/recipe">Install recipe<\/a>/);
    expect(shown.html).toMatch(/<a href="\/platforms\/acme\/worker">A code worker<\/a>/);
    expect(shown.html).not.toContain('href="/platforms/acme/worker/recipe"');
  });

  it("gives the pages it links to", async () => {
    const { mo } = await platforms();
    const as = { cookie: mo.cookie };
    expect((await renderPage(PlatformPage, { owner: "acme", slug: "back-office" }, { as })).status).toBe(200);
    expect((await renderPage(PlatformRecipePage, { owner: "acme", slug: "back-office" }, { as })).status).toBe(200);
  });

  it("puts a shorter version of the help under the list, for those who may add platforms there", async () => {
    const { mo, nell } = await platforms();
    const words = text((await page("acme", { cookie: mo.cookie })).html);
    expect(words).toContain(
      "Add or change a platform Ask your own AI through the registry's MCP server, or push the description file with the API. " +
        "Each change saves a new version, and the fit always uses the latest. http://localhost:3000/mcp",
    );
    expect(words.indexOf("A code worker")).toBeLessThan(words.indexOf("Add or change a platform"));
    expect(words).not.toContain("off_for_up_to");
    expect(text((await page("acme", { cookie: nell.cookie })).html)).not.toContain("Add or change a platform");
  });

  it("shows an organisation's tabs to its members, with Platforms on show", async () => {
    const { mo, nell } = await platforms();
    const asMo = await page("acme", { cookie: mo.cookie });
    expect(text(asMo.html)).toContain("Workflows Inventory Platforms Members Audit log");
    expect(asMo.html).toMatch(/<a [^>]*aria-current="page"[^>]*>Platforms<\/a>/);
    expect(asMo.html).toContain('href="/acme/platforms"');
    const asNell = await page("acme", { cookie: nell.cookie });
    expect(text(asNell.html)).not.toContain("Inventory");
    expect(asNell.html).toContain('href="/acme"');
  });

  it("is not found for an owner that does not exist", async () => {
    expect((await page("nobody-here")).status).toBe(404);
  });
});

describe("links to an owner's platforms", () => {
  it("go from the owner's page, for everyone", async () => {
    const { mo } = await platforms();
    const ana = await person("ana");
    for (const as of [undefined, { cookie: mo.cookie }])
      expect((await renderPage(OwnerPage, { owner: "acme" }, { as })).html).toContain('href="/acme/platforms"');
    expect((await renderPage(OwnerPage, { owner: ana.username })).html).toContain(`href="/${ana.username}/platforms"`);
  });

  it("go from the organisation's inventory", async () => {
    const { mo } = await platforms();
    const inv = await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: mo.cookie } });
    expect(text(inv.html)).toContain("Workflows Inventory Platforms Members Audit log");
    expect(inv.html).toContain('href="/acme/platforms"');
  });
});

describe("the empty state", () => {
  it("tells the owner what a platform description is, how to add or change one, and that the fit uses the latest version", async () => {
    const ana = await person("ana");
    const shown = await page(ana.username, { cookie: ana.cookie });
    expect(shown.status).toBe(200);
    const words = text(shown.html);
    expect(words).toContain("ana's platforms Machines and services ana has described, so awml fit can say which ones can run a workflow. ana has no platforms yet.");
    expect(words).toContain(
      "What a platform is A platform description says where work can run, such as a laptop, a Mac mini or a server. " +
        "It is a short YAML file. It names the platform and says: " +
        'platform Its id and the label people see, such as "My laptop". ' +
        "off_for_up_to How long it may be off. PT0S means it is always on. P14D suits a laptop that may be shut for a fortnight. " +
        "steps What carries out the steps: code, when the platform runs the workflow's own code, or agent, when an agent follows instructions for each step. " +
        "agents Whose agents run there, such as anthropic. An empty list means only the workflow's own code runs there. " +
        "calls Whose models the workflow's code can call from there, or any. " +
        "holds Which folders it holds, such as notes. " +
        "awml fit checks a workflow against a platform description. It says whether the workflow can run there, and if not, why.",
    );
    expect(words).toContain(
      "Add or change one Ask your own AI Connect Claude or ChatGPT to the registry's MCP server at this address. " +
        "It runs on your account, not ours. http://localhost:3000/mcp Then ask it, for example: " +
        "Add a platform for my laptop that holds my notes folder, then fit my workflow against it.",
    );
    expect(words).toContain(
      "Push from your machine Push the description file with the API, using a token from Settings. " +
        "jq -Rs '{description: .}' laptop.yaml | curl -X POST \\ " +
        `http://localhost:3000/api/v1/platforms/${ana.username}/laptop/versions \\ ` +
        '-H "Authorization: Bearer <token>" \\ -H "content-type: application/json" \\ --data-binary @-',
    );
    expect(shown.html).toContain('href="/settings/tokens"');
    expect(words).toContain(
      "Each change is a new version Each change saves a new version. The version before stays as it is. " +
        "The fit always uses the latest version.",
    );
    expect(words).toContain("Other people publish platforms too. See shared platforms.");
    expect(shown.html).toMatch(/<a [^>]*href="\/platforms"[^>]*>See shared platforms<\/a>/);
  });

  it("names the organisation in the example request and the push, for a member of one", async () => {
    const olive = await person("olive");
    const mo = await person("mo");
    await orgWith("acme", olive, [mo]);
    const words = text((await page("acme", { cookie: mo.cookie })).html);
    expect(words).toContain("acme has no platforms yet.");
    expect(words).toContain("Add a platform to acme for my laptop that holds my notes folder, then fit my workflow against it.");
    expect(words).toContain("http://localhost:3000/api/v1/platforms/acme/laptop/versions");
  });

  it("explains platforms but offers no way to add one to someone who cannot add one there", async () => {
    const ana = await person("ana");
    const nell = await person("nell");
    for (const as of [undefined, { cookie: nell.cookie }]) {
      const shown = await page(ana.username, as);
      const words = text(shown.html);
      expect(words).toContain("ana has no public platforms.");
      expect(words).toContain("What a platform is");
      expect(words).toContain("Only ana can add platforms here.");
      expect(words).toContain("See shared platforms");
      expect(words).not.toContain("/mcp");
      expect(words).not.toContain("Ask your own AI");
    }
  });

  it("gives an example request the MCP tools carry out: add_platform, then fit_workflow", async () => {
    const ana = await person("ana");
    const published = await call("publish", { owner: ana.username, slug: "client-email", security: example("client-email.yaml") }, ana.token);
    expect(published.isError).toBe(false);
    const added = await call("add_platform", { owner: ana.username, slug: "laptop", description: laptop }, ana.token);
    expect(added.isError).toBe(false);
    const fitted = await call(
      "fit_workflow",
      { workflow: `${ana.username}/client-email`, platforms: [`${ana.username}/laptop`] },
      ana.token,
    );
    expect(fitted.isError).toBe(false);
    expect(fitted.data.results).toEqual([expect.objectContaining({ platform: `${ana.username}/laptop`, label: "Codex on a laptop" })]);
    expect(text((await page(ana.username, { cookie: ana.cookie })).html)).toContain("Codex on a laptop ana/laptop Public · Version 1");
  });
});

describe("the shared platforms page", () => {
  it("lists every platform the viewer may see, newest first, each linked to its owner's platforms", async () => {
    await platforms();
    const shown = await shared();
    const words = text(shown.html);
    expect(words).toContain("Shared platforms Public platforms from every owner.");
    expect(words.indexOf("beta/open-box")).toBeLessThan(words.indexOf("acme/worker"));
    expect(shown.html).toContain('href="/beta/platforms"');
    expect(shown.html).toContain('href="/platforms/beta/open-box"');
    expect(shown.html).toContain('action="/platforms"');
  });

  it("searches them by label or slug", async () => {
    const { mo } = await platforms();
    const words = text((await shared({ cookie: mo.cookie }, "back office")).html);
    expect(words).toContain("acme/back-office");
    expect(words).not.toContain("acme/worker");
    expect(text((await shared(undefined, "box")).html)).toContain("beta/open-box");
    expect(text((await shared(undefined, "%")).html)).toContain("No platform you can see has that in its label.");
  });

  it("says so when there are none", async () => {
    expect(text((await shared()).html)).toContain("No shared platforms yet.");
  });
});

describe("Private platforms on the platform pages", () => {
  it("positive: a member sees their organisation's private platforms on its page and among the shared ones", async () => {
    const { olive, mo } = await platforms();
    for (const who of [olive, mo]) {
      expect(text((await page("acme", { cookie: who.cookie })).html)).toContain("Acme's back office acme/back-office Private");
      const words = text((await shared({ cookie: who.cookie })).html);
      expect(words).toContain("Public platforms from every owner, and your organisations' private ones.");
      expect(words).toContain("acme/back-office");
    }
  });

  it("negative: a non-member and a signed-out visitor never see a private platform listed, and its files are not found", async () => {
    const { nell } = await platforms();
    for (const as of [undefined, { cookie: nell.cookie }]) {
      const onPage = await page("acme", as);
      expect(onPage.status).toBe(200);
      expect(text(onPage.html)).toContain("acme/worker");
      for (const html of [onPage.html, (await shared(as)).html, (await shared(as, "back")).html]) {
        expect(html).not.toContain("back-office");
        expect(text(html)).not.toContain("Acme's back office");
      }
      expect((await request("GET", "/platforms/acme/back-office/v/1/description.yaml", { as })).status).toBe(404);
    }
  });

  it("negative: an organisation whose platforms are all private looks the same as one with none", async () => {
    const olive = await person("olive");
    const nell = await person("nell");
    await orgWith("acme", olive);
    await orgWith("zeta", olive);
    await pushPlatform("acme", "back-office", { token: olive.token }, { description: backOffice, visibility: "private" });
    const words = text((await page("acme", { cookie: nell.cookie })).html);
    expect(words).toContain("acme has no public platforms.");
    expect(words.replaceAll("acme", "X")).toBe(text((await page("zeta", { cookie: nell.cookie })).html).replaceAll("zeta", "X"));
  });

  it("cross-tenant: a member of one organisation never sees another organisation's private platforms", async () => {
    const { mo, bea } = await platforms();
    const betaAsMo = text((await page("beta", { cookie: mo.cookie })).html);
    expect(betaAsMo).toContain("beta/open-box");
    expect(betaAsMo).not.toContain("beta/vault");
    expect(betaAsMo).not.toContain("Add or change a platform");
    expect(text((await page("acme", { cookie: bea.cookie })).html)).not.toContain("acme/back-office");
    const sharedAsMo = text((await shared({ cookie: mo.cookie })).html);
    expect(sharedAsMo).toContain("acme/back-office");
    expect(sharedAsMo).not.toContain("beta/vault");
    expect(sharedAsMo).not.toContain("Beta's vault server");
  });
});

// A platform's own page: what it offers in plain words, its install recipe
// and its description file, each tab its own address.

// A description whose comments say why each value is what it is.
const commented = `# Codex on Ana's laptop, which she shuts when she travels.
# Set up as https://example.com/codex-setup says.

awml: "0.3"
platform: { id: codex-laptop, label: "Codex on a laptop" }
# Shut for up to a fortnight on holiday.
# See https://example.com/holidays.
off_for_up_to: P14D
# Codex runs the workflow's own code.
steps: code
# Codex is OpenAI's agent.
agents: [openai]
calls: any
# Only the notes folder syncs to it.
holds: [notes, drafts]
`;
const recipeWithHtml = `# Install on the laptop

1. Install [Codex](https://example.com/codex).
2. Run \`codex login\`.

<script>alert(1)</script>
`;

// The page's tabs: where each goes, what it says, and whether it is on show.
const tabsOf = (html: string) =>
  [...html.matchAll(/<a role="tab" href="([^"]*)" aria-selected="(true|false)">(.*?)<\/a>/g)].map(([, href, selected, inner]) => ({
    href,
    label: text(inner).trim(),
    selected: selected === "true",
  }));
const headOf = (html: string) => text(html.split('<section class="wf-head">')[1].split("</section>")[0]).trim();
const show = (P: Page<{ owner: string; slug: string }>, owner: string, slug: string, as?: Who) =>
  renderPage(P, { owner, slug }, { as });

async function laptopFor(name = "ana") {
  const ana = await person(name);
  await pushPlatform(ana.username, "laptop", { token: ana.token }, { description: commented, recipe: recipeWithHtml });
  return ana;
}

describe("a platform's page", () => {
  it("has a header of crumb, label, visibility and version, the file's top comment, and three tabs, each its own address", async () => {
    const ana = await laptopFor();
    const o = ana.username;
    const page = await show(PlatformPage, o, "laptop");
    expect(page.status).toBe(200);
    expect(headOf(page.html)).toBe(
      `${o} / platforms / laptop Codex on a laptop Public · Version 1 of 1 ` +
        "Codex on Ana's laptop, which she shuts when she travels. Set up as https://example.com/codex-setup says.",
    );
    expect(page.html).toContain(`<a href="/${o}">${o}</a> / <a href="/${o}/platforms">platforms</a> / laptop`);
    expect(page.html).toContain('<a href="https://example.com/codex-setup">https://example.com/codex-setup</a>');
    expect(tabsOf(page.html)).toEqual([
      { href: `/platforms/${o}/laptop`, label: "What it offers", selected: true },
      { href: `/platforms/${o}/laptop/recipe`, label: "Install recipe", selected: false },
      { href: `/platforms/${o}/laptop/yaml`, label: "YAML", selected: false },
    ]);
    for (const P of [PlatformRecipePage, PlatformYamlPage]) {
      const other = await show(P, o, "laptop");
      expect(other.status).toBe(200);
      expect(headOf(other.html)).toBe(headOf(page.html));
    }
    expect(tabsOf((await show(PlatformYamlPage, o, "laptop")).html).filter((t) => t.selected).map((t) => t.href)).toEqual([
      `/platforms/${o}/laptop/yaml`,
    ]);
  });

  it("says what it offers in plain words, each field with the comment above it as evidence, its links kept", async () => {
    const ana = await laptopFor();
    const page = await show(PlatformPage, ana.username, "laptop");
    const words = text(page.html);
    expect(words).toContain(
      "Off for up to 14 days Shut for up to a fortnight on holiday. See https://example.com/holidays. " +
        "Runs steps as code Codex runs the workflow's own code. " +
        "AI from openai Codex is OpenAI's agent. " +
        "Can call any company " +
        "Holds notes and drafts Only the notes folder syncs to it.",
    );
    expect(page.html).toContain('<a href="https://example.com/holidays">https://example.com/holidays</a>.');
  });

  it("puts the words for an always-on agent platform that calls named companies and holds nothing", async () => {
    const ana = await person("ana");
    const box = `awml: "0.3"
platform: { id: box, label: "A box" }
off_for_up_to: P2DT1H30M
steps: agent
agents: []
calls: [anthropic, openai]
holds: []
`;
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: box });
    const words = text((await show(PlatformPage, ana.username, "box")).html);
    expect(words).toContain(
      "Off for up to 2 days, 1 hour and 30 minutes Runs steps as an AI agent AI from none " +
        "Can call anthropic and openai Holds nothing",
    );
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: box.replace("P2DT1H30M", "PT0S") });
    expect(text((await show(PlatformPage, ana.username, "box")).html)).toContain("Off for up to no time: it is always on");
  });

  it("offers the command to check a workflow against it", async () => {
    const ana = await laptopFor();
    const words = text((await show(PlatformPage, ana.username, "laptop")).html);
    expect(words).toContain(
      "Check a workflow against it awml fit workflow.yaml laptop.yaml " +
        "awml fit says whether the workflow can run here, or every reason it can't.",
    );
  });

  it("renders the install recipe as HTML, with no raw HTML let through", async () => {
    const ana = await laptopFor();
    const page = await show(PlatformRecipePage, ana.username, "laptop");
    expect(page.html).toContain("<h1>Install on the laptop</h1>");
    expect(page.html).toContain('<li>Install <a href="https://example.com/codex">Codex</a>.</li>');
    expect(page.html).toContain("<code>codex login</code>");
    expect(page.html).not.toContain("<script>");
    expect(page.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text(page.html)).not.toContain("Off for up to");
  });

  it("says when there is no install recipe yet, and is still found", async () => {
    const ana = await person("ana");
    await pushPlatform(ana.username, "worker", { token: ana.token }, { description: worker });
    const page = await show(PlatformRecipePage, ana.username, "worker");
    expect(page.status).toBe(200);
    expect(text(page.html)).toContain("This platform has no install recipe yet.");
  });

  it("shows the raw description under YAML, with Copy and Download", async () => {
    const ana = await laptopFor();
    const o = ana.username;
    const page = await show(PlatformYamlPage, o, "laptop");
    const pre = page.html.match(/<pre id="description-yaml">([^]*?)<\/pre>/)![1];
    expect(pre.replace(/&#x27;/g, "'").replace(/&quot;/g, '"')).toBe(commented);
    expect(page.html).toContain('<button type="button" class="button outline" aria-controls="description-yaml">Copy</button>');
    expect(page.html).toContain(`<a href="/platforms/${o}/laptop/v/1/description.yaml" class="button outline" download="">Download</a>`);
    expect(text(page.html)).not.toContain("Check a workflow against it");
  });

  it("gives an older version its own page and tabs, and lists the versions", async () => {
    const ana = await laptopFor();
    const o = ana.username;
    await pushPlatform(o, "laptop", { token: ana.token }, { description: commented.replace("P14D", "P7D") });
    const v1 = { owner: o, slug: "laptop", n: "1" };
    const old = await renderPage(PlatformVersionPage, v1);
    expect(old.status).toBe(200);
    expect(headOf(old.html)).toContain("Codex on a laptop Public · Version 1 of 2");
    expect(text(old.html)).toContain("Off for up to 14 days");
    expect(tabsOf(old.html).map((t) => t.href)).toEqual([
      `/platforms/${o}/laptop/v/1`,
      `/platforms/${o}/laptop/v/1/recipe`,
      `/platforms/${o}/laptop/v/1/yaml`,
    ]);
    expect(old.html).toContain(`href="/platforms/${o}/laptop">Version 2</a>`);
    expect(text((await show(PlatformPage, o, "laptop")).html)).toContain("Off for up to 7 days");
    expect(text((await renderPage(PlatformVersionRecipePage, v1)).html)).toContain("Install on the laptop");
    expect((await renderPage(PlatformVersionYamlPage, v1)).html).toContain(`href="/platforms/${o}/laptop/v/1/description.yaml"`);
    expect((await renderPage(PlatformVersionPage, { ...v1, n: "3" })).status).toBe(404);
  });

  it("is not found for a platform that does not exist", async () => {
    expect((await show(PlatformPage, "nobody-here", "laptop")).status).toBe(404);
  });

  it("sends an old username's address for good (308) to the same page under the new name", async () => {
    const ana = await laptopFor();
    const res = await request("PATCH", "/api/v1/me", { as: { token: ana.token }, json: { username: "ana-new" } });
    expect(res.status).toBe(200);
    expect(await show(PlatformPage, ana.username, "laptop")).toMatchObject({ status: 308, location: "/platforms/ana-new/laptop" });
    expect(await show(PlatformYamlPage, ana.username, "laptop")).toMatchObject({
      status: 308,
      location: "/platforms/ana-new/laptop/yaml",
    });
    expect(await renderPage(PlatformVersionRecipePage, { owner: ana.username, slug: "laptop", n: "1" })).toMatchObject({
      status: 308,
      location: "/platforms/ana-new/laptop/v/1/recipe",
    });
    expect((await show(PlatformPage, "ana-new", "laptop")).status).toBe(200);
  });
});

describe("Private platforms on a platform's page", () => {
  const tabs = [PlatformPage, PlatformRecipePage, PlatformYamlPage];

  it("positive: the owner and a member of the organisation see its private platform", async () => {
    const { olive, mo } = await platforms();
    for (const who of [olive, mo])
      for (const P of tabs) {
        const page = await show(P, "acme", "back-office", { cookie: who.cookie });
        expect(page.status).toBe(200);
        expect(headOf(page.html)).toContain("Acme's back office Private · Version 1 of 1");
      }
    expect((await renderPage(PlatformVersionPage, { owner: "acme", slug: "back-office", n: "1" }, { as: { cookie: mo.cookie } })).status).toBe(200);
  });

  it("negative: a non-member and a signed-out visitor get a 404 on every tab and version", async () => {
    const { nell } = await platforms();
    for (const as of [undefined, { cookie: nell.cookie }]) {
      for (const P of tabs) expect((await show(P, "acme", "back-office", as)).status).toBe(404);
      expect((await renderPage(PlatformVersionPage, { owner: "acme", slug: "back-office", n: "1" }, { as })).status).toBe(404);
    }
  });

  it("cross-tenant: a member of one organisation gets a 404 on another's private platform", async () => {
    const { mo, bea } = await platforms();
    expect((await show(PlatformPage, "beta", "vault", { cookie: mo.cookie })).status).toBe(404);
    expect((await show(PlatformPage, "acme", "back-office", { cookie: bea.cookie })).status).toBe(404);
    expect((await show(PlatformPage, "beta", "open-box", { cookie: mo.cookie })).status).toBe(200);
  });
});
